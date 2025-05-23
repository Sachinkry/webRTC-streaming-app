import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Server as SocketIOServer, Socket } from 'socket.io';
import http from 'http';
import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';
import { config as mediasoupAppConfig } from './mediasoup.config';
import { logger } from 'hono/logger';
import { Worker } from 'worker_threads';
import { Readable, Writable } from 'stream'; // Import Writable for type check if needed
import { exec, spawn } from 'child_process'; 
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execPromise = promisify(exec);

// --- Mediasoup Globals encapsulated in a class ---
class MediasoupController {
    private worker!: mediasoupTypes.Worker;
    private router!: mediasoupTypes.Router;
    private transports = new Map<string, mediasoupTypes.WebRtcTransport>();
    private producers = new Map<string, mediasoupTypes.Producer>();
    private consumers = new Map<string, mediasoupTypes.Consumer>();
    private peerState = new Map<string, { producers: string[], consumers: string[] }>();
    private hlsStreams = new Map<string, { ffmpegProcess: import('child_process').ChildProcessWithoutNullStreams, statsInterval: NodeJS.Timeout }>();
    private hlsStatsIntervals: Map<string, NodeJS.Timeout> = new Map();

    constructor() {}

    public async startMediasoup() {
        console.log('Starting Mediasoup worker...');
        if (!mediasoup || typeof mediasoup.createWorker !== 'function') {
            console.error('Mediasoup or mediasoup.createWorker is not available. Check import.');
            throw new Error('Mediasoup not initialized correctly.');
        }
        this.worker = await mediasoup.createWorker({
            logLevel: mediasoupAppConfig.mediasoup.workerSettings.logLevel,
            logTags: mediasoupAppConfig.mediasoup.workerSettings.logTags,
            rtcMinPort: mediasoupAppConfig.mediasoup.workerSettings.rtcMinPort,
            rtcMaxPort: mediasoupAppConfig.mediasoup.workerSettings.rtcMaxPort,
        });

        this.worker.on('died', (error) => {
            console.error('Mediasoup worker has died:', error);
            setTimeout(() => process.exit(1), 2000);
        });
        console.log(`Mediasoup worker started [pid:${this.worker.pid}]`);

        this.router = await this.worker.createRouter({ mediaCodecs: mediasoupAppConfig.mediasoup.router.mediaCodecs });
        console.log(`Mediasoup router created [id:${this.router.id}]`);
    }

    public getRouterRtpCapabilities(): mediasoupTypes.RtpCapabilities | null {
        return this.router ? this.router.rtpCapabilities : null;
    }

    public async createWebRtcTransport(socketId: string, sender: boolean): Promise<any> {
        if (!this.router) {
            throw new Error('Router not initialized');
        }
        const listenIps = mediasoupAppConfig.mediasoup.webRtcTransport.listenIps.map(ip => ({ ...ip }));

        const transport = await this.router.createWebRtcTransport({
            listenIps: listenIps,
            enableUdp: mediasoupAppConfig.mediasoup.webRtcTransport.enableUdp,
            enableTcp: mediasoupAppConfig.mediasoup.webRtcTransport.enableTcp,
            preferUdp: mediasoupAppConfig.mediasoup.webRtcTransport.preferUdp,
            initialAvailableOutgoingBitrate: mediasoupAppConfig.mediasoup.webRtcTransport.initialAvailableOutgoingBitrate,
            appData: { peerId: socketId, clientIsSender: sender },
        });
        this.transports.set(transport.id, transport);
        console.log(`[${socketId}] Transport created: ${transport.id}`);

        transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'closed') {
                console.log(`[${socketId}] Transport ${transport.id} DTLS state closed`);
                transport.close();
                this.transports.delete(transport.id);
            }
        });

        return {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            sctpParameters: transport.sctpParameters,
        };
    }

    public async connectWebRtcTransport(socketId: string, transportId: string, dtlsParameters: mediasoupTypes.DtlsParameters) {
        const transport = this.transports.get(transportId);
        if (!transport) {
            throw new Error(`Transport with id "${transportId}" not found`);
        }
        await transport.connect({ dtlsParameters });
        console.log(`[${socketId}] Transport ${transportId} connected`);
    }

    public async produce(socketId: string, transportId: string, kind: mediasoupTypes.MediaKind, rtpParameters: mediasoupTypes.RtpParameters, appData: any): Promise<mediasoupTypes.Producer> {
        const transport = this.transports.get(transportId);
        if (!transport) {
            throw new Error(`Transport with id "${transportId}" not found`);
        }
        const producer = await transport.produce({
            kind,
            rtpParameters,
            appData: { ...appData, peerId: socketId, transportId },
        });
        this.producers.set(producer.id, producer);
        const peerStateEntry = this.peerState.get(socketId);
        if (peerStateEntry) {
            peerStateEntry.producers.push(producer.id);
        } else {
            this.peerState.set(socketId, { producers: [producer.id], consumers: [] });
        }
        console.log(`[${socketId}] Producer created: ${producer.id} (kind: ${kind})`);

        if (kind === 'video') {
            // Start HLS conversion for this producer if not already running
            if (!this.hlsStreams.has(producer.id)) {
                console.log(`[HLS TRIGGER ${producer.id}] Starting new HLS stream for video producer ${producer.id}.`);
                this.startHlsConversion(producer.id, socketId)
                    .catch(err => {
                        console.error(`[HLS FATAL UNHANDLED ${producer.id}] Error in startHlsConversion promise: ${err.message}`, err.stack);
                        this.hlsStreams.delete(producer.id);
                    });
            }
        }

        producer.on('transportclose', () => {
            console.log(`[${socketId}] Producer ${producer.id} transport closed`);
            producer.close();
            this.producers.delete(producer.id);
            const peerProds = this.peerState.get(socketId)?.producers;
            if (peerProds) this.peerState.get(socketId)!.producers = peerProds.filter(pId => pId !== producer.id);
            
            // Cleanup HLS stream if exists
            const hlsStream = this.hlsStreams.get(producer.id);
            if (hlsStream) {
                if (hlsStream.ffmpegProcess && !hlsStream.ffmpegProcess.killed) {
                    hlsStream.ffmpegProcess.kill('SIGINT');
                    setTimeout(() => {
                        if (hlsStream.ffmpegProcess && !hlsStream.ffmpegProcess.killed) {
                            hlsStream.ffmpegProcess.kill('SIGKILL');
                        }
                    }, 1000);
                }
                clearInterval(hlsStream.statsInterval);
                this.hlsStreams.delete(producer.id);
            }
        });
        return producer;
    }

    public async consume(socketId: string, producerId: string, rtpCapabilities: mediasoupTypes.RtpCapabilities, transportId: string): Promise<mediasoupTypes.Consumer> {
        if (!this.router) {
            throw new Error('Router not initialized');
        }
        const producerToConsume = this.producers.get(producerId);
        if (!producerToConsume) {
            throw new Error(`Producer with id "${producerId}" not found`);
        }
        if (!this.router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error('Cannot consume this producer');
        }
        const transport = this.transports.get(transportId);
        if (!transport) {
            throw new Error(`Receiving transport with id "${transportId}" not found.`);
        }

        const consumer = await transport.consume({
            producerId,
            rtpCapabilities,
            paused: true,
            appData: { peerId: socketId, producerId }
        });
        this.consumers.set(consumer.id, consumer);
        const peerStateEntry = this.peerState.get(socketId);
        if (peerStateEntry) {
            peerStateEntry.consumers.push(consumer.id);
        } else {
            this.peerState.set(socketId, { producers: [], consumers: [consumer.id] });
        }

        consumer.on('transportclose', () => {
            console.log(`[${socketId}] Consumer ${consumer.id} transport closed`);
            consumer.close();
            this.consumers.delete(consumer.id);
            const peerCons = this.peerState.get(socketId)?.consumers;
            if (peerCons) this.peerState.get(socketId)!.consumers = peerCons.filter(cId => cId !== consumer.id);
        });
        consumer.on('producerclose', () => {
            console.log(`[${socketId}] Consumer ${consumer.id} producer closed`);
            consumer.close();
            this.consumers.delete(consumer.id);
            const peerCons = this.peerState.get(socketId)?.consumers;
            if (peerCons) this.peerState.get(socketId)!.consumers = peerCons.filter(cId => cId !== consumer.id);
        });

        console.log(`[${socketId}] Consumer created: ${consumer.id} for producer ${producerId}`);
        return consumer;
    }

    public async resumeConsumer(socketId: string, consumerId: string) {
        const consumer = this.consumers.get(consumerId);
        if (!consumer) {
            throw new Error(`Consumer with id "${consumerId}" not found`);
        }
        await consumer.resume();
        console.log(`[${socketId}] Consumer ${consumerId} resumed`);
    }

    public getExistingProducers(currentSocketId: string) {
        const existingProducersList: { peerId: string; producerId: string; kind: mediasoupTypes.MediaKind; }[] = [];
        for (const producer of this.producers.values()) {
            if (producer.appData.peerId !== currentSocketId) {
                existingProducersList.push({
                    peerId: producer.appData.peerId as string,
                    producerId: producer.id,
                    kind: producer.kind,
                });
            }
        }
        return existingProducersList;
    }

    public cleanupPeer(socketId: string) {
        const state = this.peerState.get(socketId);
        if (state) {
            state.producers.forEach(producerId => {
                this.producers.get(producerId)?.close();
                this.producers.delete(producerId);
            });
            state.consumers.forEach(consumerId => {
                this.consumers.get(consumerId)?.close();
                this.consumers.delete(consumerId);
            });
        }
        this.peerState.delete(socketId);
    }

    private async startHlsConversion(producerId: string, socketIdForLog: string) {
        console.log(`[HLS INITIATE ${producerId}] Attempting to start HLS conversion.`);
        const outputDir = path.join(__dirname, '../public/hls', producerId);
        const outputPath = path.join(outputDir, 'stream.m3u8');
        const segmentPatternPath = path.join(outputDir, 'stream_%03d.ts');
    
        // Clear any existing stats interval for this producerId to prevent duplicates
        if (this.hlsStatsIntervals.has(producerId)) {
            clearInterval(this.hlsStatsIntervals.get(producerId)!);
            this.hlsStatsIntervals.delete(producerId);
        }
    
        try {
            if (!fs.existsSync(outputDir)) {
                console.log(`[HLS INFO ${producerId}] Creating HLS output directory: ${outputDir}`);
                fs.mkdirSync(outputDir, { recursive: true });
            } else {
                console.log(`[HLS INFO ${producerId}] HLS output directory exists: ${outputDir}`);
            }
        } catch (err: any) {
            console.error(`[HLS FATAL ${producerId}] Failed to create HLS output directory ${outputDir}: ${err.message}`);
            return;
        }
    
        const producerToConvert = this.producers.get(producerId);
        if (!producerToConvert || producerToConvert.closed) {
            console.error(`[HLS FATAL ${producerId}] Producer not found, already closed, or invalid for HLS conversion.`);
            return;
        }
        console.log(`[HLS INFO ${producerId}] Producer ${producerId} found. Kind: ${producerToConvert.kind}, Paused: ${producerToConvert.paused}, Closed: ${producerToConvert.closed}`);
        console.log(`[HLS INFO ${producerId}] Producer RTP Parameters: ${JSON.stringify(producerToConvert.rtpParameters.codecs, null, 2)}`);
    
        let hlsTransport: mediasoupTypes.PlainTransport | null = null;
        let hlsConsumer: mediasoupTypes.Consumer | null = null;
        let ffmpegProcess: import('child_process').ChildProcessWithoutNullStreams | null = null;
        const rtpStream = new Readable({ read() {}, destroy(error, callback) {
            console.log(`[HLS INFO ${producerId}] RTP ReadableStream destroyed for HLS. Error: ${error?.message || 'None'}`);
            callback(error);
        }});
    
        const cleanupHlsResources = (origin: string) => {
            console.log(`[HLS CLEANUP ${producerId}] Initiated from: ${origin}.`);
            if (this.hlsStatsIntervals.has(producerId)) {
                clearInterval(this.hlsStatsIntervals.get(producerId)!);
                this.hlsStatsIntervals.delete(producerId);
                console.log(`[HLS CLEANUP ${producerId}] Cleared stats interval.`);
            }
            if (rtpStream && !rtpStream.destroyed) rtpStream.destroy();
            if (hlsConsumer && !hlsConsumer.closed) hlsConsumer.close();
            if (hlsConsumer) this.consumers.delete(hlsConsumer.id);
            if (hlsTransport && !hlsTransport.closed) hlsTransport.close();
            if (ffmpegProcess && !ffmpegProcess.killed) {
                console.log(`[HLS CLEANUP ${producerId}] Killing FFmpeg process (PID: ${ffmpegProcess.pid}).`);
                ffmpegProcess.kill('SIGINT'); // SIGKILL if it doesn't die
                setTimeout(() => { if (ffmpegProcess && !ffmpegProcess.killed) ffmpegProcess.kill('SIGKILL'); }, 1500);
            }
            // Remove HLS output directory and its files
            try {
                if (fs.existsSync(outputDir)) {
                    fs.rmSync(outputDir, { recursive: true, force: true });
                    console.log(`[HLS CLEANUP ${producerId}] Deleted HLS output directory: ${outputDir}`);
                }
            } catch (err) {
                console.error(`[HLS CLEANUP ${producerId}] Failed to delete HLS output directory: ${err}`);
            }
        };
    
        try {
            hlsTransport = await this.router.createPlainTransport({
                listenIp: mediasoupAppConfig.mediasoup.plainTransport.listenIp, rtcpMux: false, // mediasoup default is rtcpMux: true. Set to false if FFmpeg needs separate RTCP. For pipe, might not matter.
                appData: { purpose: 'hls-conversion', producerId },
            });
            console.log(`[HLS INFO ${producerId}] PlainTransport ${hlsTransport.id} created for HLS.`);
    
            hlsConsumer = await hlsTransport.consume({
                producerId: producerId,
                rtpCapabilities: this.router.rtpCapabilities,
                paused: producerToConvert.paused, // Start consumer paused if producer is paused
                appData: { purpose: 'hls-conversion', producerId, sourceSocketId: socketIdForLog },
            });
            this.consumers.set(hlsConsumer.id, hlsConsumer);
            console.log(`[HLS INFO ${producerId}] Consumer ${hlsConsumer.id} (kind: ${hlsConsumer.kind}, paused: ${hlsConsumer.paused}, type: ${hlsConsumer.type}) created for HLS.`);
            console.log(`[HLS INFO ${producerId}] HLS Consumer RTP Parameters: ${JSON.stringify(hlsConsumer.rtpParameters.codecs, null, 2)}`);
    
            // Ensure consumer is resumed to receive RTP packets
            if (hlsConsumer.paused) {
                console.log(`[HLS ACTION ${producerId}] Resuming HLS consumer ${hlsConsumer.id} to start receiving RTP packets.`);
                await hlsConsumer.resume();
                console.log(`[HLS ACTION ${producerId}] HLS consumer ${hlsConsumer.id} resume call completed. Current paused state: ${hlsConsumer.paused}`);
            }
    
            const statsInterval = setInterval(async () => {
                if (hlsConsumer && !hlsConsumer.closed) {
                    try {
                        const statsArr = await hlsConsumer.getStats(); // Returns an array of reports
                        const inboundRtpStats = statsArr.find(s => s.type === 'inbound-rtp') as mediasoupTypes.RtpStreamRecvStats;
                        console.log(`[HLS STATS ${producerId}] Consumer ${hlsConsumer.id} Paused: ${hlsConsumer.paused}, Closed: ${hlsConsumer.closed}, Score: ${hlsConsumer.score}, PacketsRecv: ${inboundRtpStats?.packetsRepaired || 0}, BytesRecv: ${inboundRtpStats?.packetsLost || 0}`);
                    } catch (statsError: any) { console.error(`[HLS STATS ERROR ${producerId}] C ${hlsConsumer.id}: ${statsError.message}`); }
                } else { clearInterval(statsInterval); this.hlsStatsIntervals.delete(producerId); }
            }, 3000);
            this.hlsStatsIntervals.set(producerId, statsInterval);
    
            let rtpPacketCounter = 0;
            hlsConsumer.on('rtp', (rtpPacket: Buffer) => {
                rtpPacketCounter++;
                if (rtpPacketCounter <= 5 || rtpPacketCounter % 100 === 0) {
                    console.log(`[HLS DATA ${producerId}] RTP packet #${rtpPacketCounter} (size: ${rtpPacket.length}B) received by HLS C ${hlsConsumer?.id}.`);
                }
                if (rtpStream && !rtpStream.destroyed) rtpStream.push(rtpPacket);
            });
    
            hlsConsumer.on('producerpause', async () => {
                console.log(`[HLS EVENT ${producerId}] HLS C ${hlsConsumer?.id} producer PAUSED.`);
                if (hlsConsumer && !hlsConsumer.closed && !hlsConsumer.paused) await hlsConsumer.pause();
            });
            hlsConsumer.on('producerresume', async () => {
                console.log(`[HLS EVENT ${producerId}] HLS C ${hlsConsumer?.id} producer RESUMED.`);
                if (hlsConsumer && !hlsConsumer.closed && hlsConsumer.paused) await hlsConsumer.resume();
            });
            hlsConsumer.on('producerclose', () => cleanupHlsResources(`hlsConsumer.on(producerclose) for C ${hlsConsumer?.id}`));
            hlsConsumer.on('transportclose', () => cleanupHlsResources(`hlsConsumer.on(transportclose) for C ${hlsConsumer?.id}`));
            // Ensure original producer close also triggers cleanup
            producerToConvert.once('@close', () => cleanupHlsResources(`producerToConvert.on(@close) for P ${producerId}`));
    
    
            const consumerVideoCodec = hlsConsumer.rtpParameters.codecs.find(c => c.mimeType.toLowerCase().startsWith('video/'));
            if (!consumerVideoCodec) {
                console.error(`[HLS FATAL ${producerId}] HLS Consumer ${hlsConsumer.id} has no video codec after all checks.`);
                cleanupHlsResources('No video codec in HLS consumer final check'); return;
            }
            console.log(`[HLS INFO ${producerId}] HLS Consumer will use video codec: ${consumerVideoCodec.mimeType}, PT: ${consumerVideoCodec.payloadType}`);
    
            const ffmpegExecutable = 'ffmpeg';
            const ffmpegArgs = [
                '-loglevel', 'debug',
                '-protocol_whitelist', 'pipe,file,udp,rtp',
                '-f', 'rtp',
                '-i', 'pipe:0',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-profile:v', 'baseline',
                '-level', '3.0',
                '-an',
                '-f', 'hls',
                '-hls_time', '2',
                '-hls_list_size', '5',
                '-hls_flags', 'delete_segments+omit_endlist',
                '-hls_segment_type', 'mpegts',
                '-hls_segment_filename', segmentPatternPath,
                '-fflags', '+nobuffer',  // Reduce latency
                '-flags', 'low_delay',   // Reduce latency
                '-probesize', '32',      // Reduce probe time
                '-analyzeduration', '0', // Reduce analyze time
                '-hls_allow_cache', '0', // Disable caching
                '-hls_init_time', '1',   // Initial segment duration
                '-hls_flags', 'independent_segments', // Make segments independent
                '-hls_playlist_type', 'event', // Enable live streaming
                '-hls_flags', 'append_list', // Append to playlist instead of overwriting
                '-hls_flags', 'split_by_time', // Split segments by time
                '-hls_flags', 'delete_segments', // Delete old segments
                '-hls_flags', 'omit_endlist', // Don't write endlist tag
                outputPath
            ];
            console.log(`[HLS CMD ${producerId}] Spawning FFmpeg: ${ffmpegExecutable} ${ffmpegArgs.join(' ')}`);
            ffmpegProcess = spawn(ffmpegExecutable, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

            if (ffmpegProcess.stdin) {
                console.log(`[HLS INFO ${producerId}] Piping RTP stream to FFmpeg (PID: ${ffmpegProcess.pid}) stdin.`);
                rtpStream.pipe(ffmpegProcess.stdin)
                    .on('error', (e: Error) => { 
                        console.error(`[HLS FATAL ${producerId}] RTP stream pipe error: ${e.message}`);
                        cleanupHlsResources(`rtpStream.pipe.error: ${e.message}`); 
                    })
                    .on('finish', () => console.log(`[HLS INFO ${producerId}] RTP stream finished piping to FFmpeg stdin.`));
            } else { 
                console.error(`[HLS FATAL ${producerId}] FFmpeg process did not provide stdin stream`);
                cleanupHlsResources('ffmpeg.stdin missing'); 
                return; 
            }
    
            let m3u8CreationLogged = false;
            const ffmpegMonitorInterval = setInterval(() => {
                if (ffmpegProcess && !ffmpegProcess.killed) {
                    if (fs.existsSync(outputPath)) {
                        if (!m3u8CreationLogged) {
                            console.log(`[HLS SUCCESS ${producerId}] FFmpeg (PID: ${ffmpegProcess.pid}) created ${outputPath}!`);
                            m3u8CreationLogged = true;
                        }
                        // Log the contents of the m3u8 file
                        try {
                            const m3u8Content = fs.readFileSync(outputPath, 'utf8');
                            console.log(`[HLS DEBUG ${producerId}] Current m3u8 content:\n${m3u8Content}`);
                        } catch (err) {
                            console.error(`[HLS ERROR ${producerId}] Failed to read m3u8 file: ${err}`);
                        }
                    } else {
                        console.log(`[HLS WAITING ${producerId}] Waiting for FFmpeg to create ${outputPath}...`);
                    }
                }
            }, 2000);
            this.hlsStatsIntervals.set(`${producerId}_ffmpegMon`, ffmpegMonitorInterval);
    
            const ffmpegOutputTimeout = setTimeout(() => {
                if (ffmpegProcess && !ffmpegProcess.killed && !fs.existsSync(outputPath)) {
                    console.error(`[HLS TIMEOUT ${producerId}] FFmpeg (PID: ${ffmpegProcess.pid}) did not produce m3u8 in 40s. Killing.`);
                    cleanupHlsResources('ffmpegOutputTimeout');
                }
            }, 40000);

            ffmpegProcess.on('spawn', () => console.log(`[HLS EVENT ${producerId}] FFmpeg process (PID: ${ffmpegProcess?.pid}) SPAWNED.`));
            ffmpegProcess.on('error', (err: Error) => { 
                clearTimeout(ffmpegOutputTimeout); 
                cleanupHlsResources(`ffmpeg.on(error): ${err.message}`); 
            });
            ffmpegProcess.on('close', (code, signal) => {
                console.log(`[HLS INFO ${producerId}] FFmpeg process closed with code ${code} and signal ${signal}`);
                if (hlsTransport) {
                    hlsTransport.close();
                }
                if (hlsConsumer) {
                    hlsConsumer.close();
                }
                if (rtpStream) {
                    rtpStream.destroy();
                }
                clearInterval(statsInterval);
                this.hlsStreams.delete(producerId);
            });
            ffmpegProcess.stdout?.on('data', (data: Buffer) => console.log(`[HLS FFmpeg STDOUT ${producerId}] ${data.toString().trim()}`));
            ffmpegProcess.stderr?.on('data', (data: Buffer) => {
                const stderrMsg = data.toString().trim();
                console.error(`[HLS FFmpeg STDERR ${producerId}] ${stderrMsg}`);
            });
    
        } catch (error: any) {
            console.error(`[HLS FATAL ${producerId}] Outer catch for HLS setup: ${error.message}\nStack: ${error.stack}`);
            cleanupHlsResources(`Outer catch block for ${producerId}`);
        }
    }
}

// --- Socket.IO Signaling Handler Class ---
class SocketHandler {
    private io: SocketIOServer;
    private mediasoupController: MediasoupController;

    constructor(io: SocketIOServer, mediasoupController: MediasoupController) {
        this.io = io;
        this.mediasoupController = mediasoupController;
        this.setupSocketEvents();
    }

    private setupSocketEvents() {
        this.io.on('connection', (socket: Socket) => {
            console.log(`Socket connected: ${socket.id}`);

            socket.on('disconnect', () => {
                console.log(`Socket disconnected: ${socket.id}`);
                this.mediasoupController.cleanupPeer(socket.id);
                socket.broadcast.emit('peer-disconnected', { peerId: socket.id });
            });

            socket.on('getRouterRtpCapabilities', (callback) => {
                console.log(`[${socket.id}] getRouterRtpCapabilities`);
                const rtpCapabilities = this.mediasoupController.getRouterRtpCapabilities();
                if (!rtpCapabilities) {
                    return callback({ error: 'Router not initialized' });
                }
                callback(rtpCapabilities);
            });

            socket.on('createWebRtcTransport', async ({ sender }: { sender: boolean }, callback) => {
                console.log(`[${socket.id}] createWebRtcTransport (sender: ${sender})`);
                try {
                    const transportInfo = await this.mediasoupController.createWebRtcTransport(socket.id, sender);
                    callback(transportInfo);
                } catch (error) {
                    console.error(`[${socket.id}] Error creating transport:`, error);
                    callback({ error: (error as Error).message });
                }
            });

            socket.on('connectWebRtcTransport', async ({ transportId, dtlsParameters }, callback) => {
                console.log(`[${socket.id}] connectWebRtcTransport (transportId: ${transportId})`);
                try {
                    await this.mediasoupController.connectWebRtcTransport(socket.id, transportId, dtlsParameters);
                    callback({});
                } catch (error) {
                    console.error(`[${socket.id}] Error connecting transport ${transportId}:`, error);
                    callback({ error: (error as Error).message });
                }
            });

            socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
                console.log(`[${socket.id}] produce (transportId: ${transportId}, kind: ${kind})`);
                try {
                    const producer = await this.mediasoupController.produce(socket.id, transportId, kind, rtpParameters, appData);
                    socket.broadcast.emit('new-producer', {
                        peerId: socket.id,
                        producerId: producer.id,
                        kind: producer.kind,
                    });
                    callback({ id: producer.id });
                } catch (error) {
                    console.error(`[${socket.id}] Error producing:`, error);
                    callback({ error: (error as Error).message });
                }
            });

            socket.on('consume', async ({ producerId, rtpCapabilities, transportId }, callback) => {
                console.log(`[${socket.id}] consume (producerId: ${producerId}, transportId: ${transportId})`);
                try {
                    const consumer = await this.mediasoupController.consume(socket.id, producerId, rtpCapabilities, transportId);
                    consumer.on('producerclose', () => {
                        console.log(`[${socket.id}] Consumer ${consumer.id} producer closed`);
                        socket.emit('consumer-closed', { consumerId: consumer.id, remotePeerId: consumer.appData.producerId });
                    });
                    callback({
                        id: consumer.id,
                        producerId: consumer.producerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                    });
                } catch (error) {
                    console.error(`[${socket.id}] Error consuming:`, error);
                    callback({ error: (error as Error).message });
                }
            });

            socket.on('resume-consumer', async ({ consumerId }, callback) => {
                console.log(`[${socket.id}] resume-consumer (consumerId: ${consumerId})`);
                try {
                    await this.mediasoupController.resumeConsumer(socket.id, consumerId);
                    callback({});
                } catch (error) {
                    console.error(`[${socket.id}] Error resuming consumer ${consumerId}:`, error);
                    callback({ error: (error as Error).message });
                }
            });

            const existingProducersList = this.mediasoupController.getExistingProducers(socket.id);
            if (existingProducersList.length > 0) {
                socket.emit('existing-producers', existingProducersList);
            }
        });
    }
}

// --- Main Signaling Server Class ---
class SignalingServer {
    private honoApp: Hono;
    private httpServer: http.Server;
    private io: SocketIOServer;
    private mediasoupController: MediasoupController;
    private socketHandler: SocketHandler;
    private port: number;

    constructor() {
        this.honoApp = new Hono();
        this.httpServer = http.createServer();
        this.io = new SocketIOServer(this.httpServer, {
            cors: { origin: "*", methods: ["GET", "POST"] }
        });
        this.mediasoupController = new MediasoupController();
        this.socketHandler = new SocketHandler(this.io, this.mediasoupController);
        this.port = parseInt(process.env.BACKEND_PORT || '3001');

        this.setupHono();
    }

    private setupHono() {
        this.honoApp.use('*', logger());
        this.honoApp.get('/', (c) => c.json({ message: 'Hono signaling server running!' }));
        this.honoApp.get('/hls/*', async (c) => {
            const filePath = path.join(__dirname, '../public/hls', c.req.path.replace('/hls/', ''));
            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                c.header('Content-Type', filePath.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T');
                c.header('Content-Length', stat.size.toString());
                return c.body(fs.createReadStream(filePath) as any);
            }
            c.status(404);
            return c.json({ error: 'File not found' });
        });
    }

    public async start() {
        await this.mediasoupController.startMediasoup();

        serve({
            fetch: this.honoApp.fetch,
            port: this.port,
            createServer: () => this.httpServer
        });

        if (!this.httpServer.listening) {
            this.httpServer.listen(this.port, () => {
                console.log(`Backend server with Hono & Socket.IO is running on http://localhost:${this.port}`);
                const mediasoupListenIpInfo = mediasoupAppConfig.mediasoup.webRtcTransport.listenIps[0];
                console.log(`Mediasoup listening on IP: ${mediasoupListenIpInfo.ip} announced as ${mediasoupListenIpInfo.announcedIp || 'auto-detected'}`);
                console.log(`Mediasoup RTC port range: ${mediasoupAppConfig.mediasoup.workerSettings.rtcMinPort}-${mediasoupAppConfig.mediasoup.workerSettings.rtcMaxPort}`);
            });
        } else {
            console.log(`Backend server with Hono & Socket.IO is running on http://localhost:${this.port}`);
            const mediasoupListenIpInfo = mediasoupAppConfig.mediasoup.webRtcTransport.listenIps[0];
            console.log(`Mediasoup listening on IP: ${mediasoupListenIpInfo.ip} announced as ${mediasoupListenIpInfo.announcedIp || 'auto-detected'}`);
            console.log(`Mediasoup RTC port range: ${mediasoupAppConfig.mediasoup.workerSettings.rtcMinPort}-${mediasoupAppConfig.mediasoup.workerSettings.rtcMaxPort}`);
        }
    }
}

// --- Start Server ---
async function run() {
    const server = new SignalingServer();
    await server.start();
}

run().catch(error => {
    console.error('Failed to start the server:', error);
    process.exit(1);
});