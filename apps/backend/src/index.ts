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
    private hlsStreamId: string | null = null;

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

        if (kind === 'video' && !this.hlsStreamId) {
            this.hlsStreamId = producer.id;
            await this.startHlsConversion(producer.id, socketId);
        }

        producer.on('transportclose', () => {
            console.log(`[${socketId}] Producer ${producer.id} transport closed`);
            producer.close();
            this.producers.delete(producer.id);
            const peerProds = this.peerState.get(socketId)?.producers;
            if (peerProds) this.peerState.get(socketId)!.producers = peerProds.filter(pId => pId !== producer.id);
            if (this.hlsStreamId === producer.id) {
                this.hlsStreamId = null;
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

    private async startHlsConversion(producerId: string, socketId: string) {
        const outputDir = path.join(__dirname, '../public/hls');
        const outputPath = path.join(outputDir, 'stream.m3u8');
    
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
    
        const hlsTransport = await this.createWebRtcTransport(socketId, false);
        await this.connectWebRtcTransport(socketId, hlsTransport.id, hlsTransport.dtlsParameters);
        console.log(`HLS transport connected: ${hlsTransport.id}`);
    
        const consumer = await this.consume(socketId, producerId, this.router.rtpCapabilities, hlsTransport.id);
        await this.resumeConsumer(socketId, consumer.id);
        console.log(`HLS consumer created for producer ${producerId}`);
    
        const rtpStream = new Readable({
            read() {}
        });
    
        consumer.on('rtp', (rtpPacket: any) => {
            if (rtpPacket.payload) {
                rtpStream.push(rtpPacket.payload);
                console.log(`Pushed RTP packet ${rtpPacket.payload.length} bytes for HLS conversion`);
            }
        });
    
        consumer.on('producerclose', () => {
            console.log(`Producer ${producerId} closed, stopping HLS conversion`);
            rtpStream.push(null);
        });
    
        consumer.on('transportclose', () => {
            console.log(`Transport closed for HLS consumer, stopping HLS conversion`);
            rtpStream.push(null);
        });
    
        const ffmpegCommand = `ffmpeg -re -i pipe:0 -c:v libx264 -preset veryfast -f hls -hls_time 4 -hls_list_size 3 -hls_flags delete_segments -hls_segment_filename "${outputDir}/stream_%03d.ts" ${outputPath}`;
        // const ffmpeg = exec(ffmpegCommand, { stdio: ['pipe', 'pipe', 'pipe'] });
        const ffmpegExecutable = 'ffmpeg';
        const ffmpegArgs = [
            '-re',
            '-i', 'pipe:0',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-f', 'hls',
            '-hls_time', '4',
            '-hls_list_size', '3',
            '-hls_flags', 'delete_segments',
            '-hls_segment_filename', `${outputDir}/stream_%03d.ts`,
            outputPath
        ];
        const ffmpeg = spawn(ffmpegExecutable, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

        if (ffmpeg.stdin) {
            rtpStream.pipe(ffmpeg.stdin);
            console.log(`Piping RTP stream to FFmpeg for HLS conversion`);
        } else {
            console.error('FFmpeg process did not provide a writable stdin stream');
        }
    
        ffmpeg.on('error', (err) => console.error('FFmpeg error:', err.message));
        ffmpeg.on('close', (code) => console.log(`FFmpeg process exited with code ${code}`));
        ffmpeg.stderr?.on('data', (data) => console.log(`FFmpeg stderr: ${data}`));
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