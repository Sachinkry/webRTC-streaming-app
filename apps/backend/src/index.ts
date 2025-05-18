// apps/backend/src/index.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Server as SocketIOServer, Socket } from 'socket.io';
import http from 'http';
import * as mediasoup from 'mediasoup'; // Updated import
import { types as mediasoupTypes } from 'mediasoup'; // Keep this for types
import { config as mediasoupAppConfig } from './mediasoup.config';
import { logger } from 'hono/logger';

// --- Mediasoup Globals ---
let worker: mediasoupTypes.Worker;
let router: mediasoupTypes.Router;
const transports = new Map<string, mediasoupTypes.WebRtcTransport>();
const producers = new Map<string, mediasoupTypes.Producer>();
const consumers = new Map<string, mediasoupTypes.Consumer>();
const peerState = new Map<string, { producers: string[], consumers: string[] }>();

async function startMediasoup() {
  console.log('Starting Mediasoup worker...');
  if (!mediasoup || typeof mediasoup.createWorker !== 'function') {
    console.error('Mediasoup or mediasoup.createWorker is not available. Check import.');
    throw new Error('Mediasoup not initialized correctly.');
  }
  worker = await mediasoup.createWorker({ // This should now work
    logLevel: mediasoupAppConfig.mediasoup.workerSettings.logLevel,
    logTags: mediasoupAppConfig.mediasoup.workerSettings.logTags,
    rtcMinPort: mediasoupAppConfig.mediasoup.workerSettings.rtcMinPort,
    rtcMaxPort: mediasoupAppConfig.mediasoup.workerSettings.rtcMaxPort,
  });

  worker.on('died', (error) => {
    console.error('Mediasoup worker has died:', error);
    setTimeout(() => process.exit(1), 2000);
  });
  console.log(`Mediasoup worker started [pid:${worker.pid}]`);

  router = await worker.createRouter({ mediaCodecs: mediasoupAppConfig.mediasoup.router.mediaCodecs });
  console.log(`Mediasoup router created [id:${router.id}]`);
}

// --- Hono App ---
const honoApp = new Hono();
honoApp.use('*', logger());
honoApp.get('/', (c) => c.json({ message: 'Hono signaling server running!' }));

// --- HTTP Server for Hono and Socket.IO ---
const httpServer = http.createServer();

// --- Socket.IO Signaling ---
const io = new SocketIOServer(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

io.on('connection', (socket: Socket) => {
  console.log(`Socket connected: ${socket.id}`);
  peerState.set(socket.id, { producers: [], consumers: [] });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    const state = peerState.get(socket.id);
    if (state) {
      state.producers.forEach(producerId => {
        producers.get(producerId)?.close();
        producers.delete(producerId);
      });
      state.consumers.forEach(consumerId => {
        consumers.get(consumerId)?.close();
        consumers.delete(consumerId);
      });
    }
    peerState.delete(socket.id);
    socket.broadcast.emit('peer-disconnected', { peerId: socket.id });
  });

  socket.on('getRouterRtpCapabilities', (callback) => {
    if (!router) {
        console.error(`[${socket.id}] getRouterRtpCapabilities: Router not initialized`);
        return callback({ error: 'Router not initialized' });
    }
    console.log(`[${socket.id}] getRouterRtpCapabilities`);
    callback(router.rtpCapabilities);
  });

  socket.on('createWebRtcTransport', async ({ sender }: { sender: boolean }, callback) => {
    console.log(`[${socket.id}] createWebRtcTransport (sender: ${sender})`);
    if (!router) {
        console.error(`[${socket.id}] createWebRtcTransport: Router not initialized`);
        return callback({ error: 'Router not initialized' });
    }
    try {
      // Ensure listenIps is mutable for Mediasoup
      const listenIps = mediasoupAppConfig.mediasoup.webRtcTransport.listenIps.map(ip => ({ ...ip }));
      
      const transport = await router.createWebRtcTransport({
        listenIps: listenIps,
        enableUdp: mediasoupAppConfig.mediasoup.webRtcTransport.enableUdp,
        enableTcp: mediasoupAppConfig.mediasoup.webRtcTransport.enableTcp,
        preferUdp: mediasoupAppConfig.mediasoup.webRtcTransport.preferUdp,
        initialAvailableOutgoingBitrate: mediasoupAppConfig.mediasoup.webRtcTransport.initialAvailableOutgoingBitrate,
        appData: { peerId: socket.id, clientIsSender: sender },
      });
      transports.set(transport.id, transport);
      console.log(`[${socket.id}] Transport created: ${transport.id}`);

      transport.on('dtlsstatechange', (dtlsState) => {
        if (dtlsState === 'closed') {
          console.log(`[${socket.id}] Transport ${transport.id} DTLS state closed`);
          transport.close();
          transports.delete(transport.id);
        }
      });

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      });
    } catch (error) {
      console.error(`[${socket.id}] Error creating transport:`, error);
      callback({ error: (error as Error).message });
    }
  });

  socket.on('connectWebRtcTransport', async ({ transportId, dtlsParameters }, callback) => {
    console.log(`[${socket.id}] connectWebRtcTransport (transportId: ${transportId})`);
    const transport = transports.get(transportId);
    if (!transport) {
      return callback({ error: `Transport with id "${transportId}" not found` });
    }
    try {
      await transport.connect({ dtlsParameters });
      console.log(`[${socket.id}] Transport ${transportId} connected`);
      callback({});
    } catch (error) {
      console.error(`[${socket.id}] Error connecting transport ${transportId}:`, error);
      callback({ error: (error as Error).message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    console.log(`[${socket.id}] produce (transportId: ${transportId}, kind: ${kind})`);
    const transport = transports.get(transportId);
    if (!transport) {
      return callback({ error: `Transport with id "${transportId}" not found` });
    }
    try {
      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { ...appData, peerId: socket.id, transportId },
      });
      producers.set(producer.id, producer);
      peerState.get(socket.id)?.producers.push(producer.id);
      console.log(`[${socket.id}] Producer created: ${producer.id} (kind: ${kind})`);
  
      producer.on('transportclose', () => {
        console.log(`[${socket.id}] Producer ${producer.id} transport closed`);
        producer.close();
        producers.delete(producer.id);
        const peerProds = peerState.get(socket.id)?.producers;
        if (peerProds) peerState.get(socket.id)!.producers = peerProds.filter(pId => pId !== producer.id);
      });
  
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
    if (!router) {
        console.error(`[${socket.id}] consume: Router not initialized`);
        return callback({ error: 'Router not initialized' });
    }
    const producerToConsume = producers.get(producerId);
    if (!producerToConsume) {
      return callback({ error: `Producer with id "${producerId}" not found` });
    }
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return callback({ error: 'Cannot consume this producer' });
    }
    const transport = transports.get(transportId);
    if (!transport) {
      return callback({ error: `Receiving transport with id "${transportId}" not found.` });
    }

    try {
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
        appData: { peerId: socket.id, producerId }
      });
      consumers.set(consumer.id, consumer);
      peerState.get(socket.id)?.consumers.push(consumer.id);

      consumer.on('transportclose', () => {
        console.log(`[${socket.id}] Consumer ${consumer.id} transport closed`);
        // Proper cleanup
        consumer.close();
        consumers.delete(consumer.id);
        const peerCons = peerState.get(socket.id)?.consumers;
        if (peerCons) peerState.get(socket.id)!.consumers = peerCons.filter(cId => cId !== consumer.id);
      });
      consumer.on('producerclose', () => {
        console.log(`[${socket.id}] Consumer ${consumer.id} producer closed`);
        socket.emit('consumer-closed', { consumerId: consumer.id, remotePeerId: producerToConsume.appData.peerId });
        // Proper cleanup
        consumer.close();
        consumers.delete(consumer.id);
        const peerCons = peerState.get(socket.id)?.consumers;
        if (peerCons) peerState.get(socket.id)!.consumers = peerCons.filter(cId => cId !== consumer.id);
      });

      console.log(`[${socket.id}] Consumer created: ${consumer.id} for producer ${producerId}`);
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
    const consumer = consumers.get(consumerId);
    if (!consumer) {
      return callback({ error: `Consumer with id "${consumerId}" not found` });
    }
    try {
      await consumer.resume();
      console.log(`[${socket.id}] Consumer ${consumerId} resumed`);
      callback({});
    } catch (error) {
      console.error(`[${socket.id}] Error resuming consumer ${consumerId}:`, error);
      callback({ error: (error as Error).message });
    }
  });

  const existingProducersList = [];
  for (const producer of producers.values()) {
    if (producer.appData.peerId !== socket.id) {
        existingProducersList.push({
            peerId: producer.appData.peerId,
            producerId: producer.id,
            kind: producer.kind,
        });
    }
  }
  if (existingProducersList.length > 0) {
    socket.emit('existing-producers', existingProducersList);
  }
});

// --- Start Server ---
const port = parseInt(process.env.BACKEND_PORT || '3001');

async function run() {
  await startMediasoup();

  serve({
    fetch: honoApp.fetch,
    port: port,
    createServer: () => httpServer // Use createServer to pass the existing http.Server
  });
  
  // The 'serve' function with 'createServer' should handle listening.
  // If not, the explicit httpServer.listen might be needed, but typically createServer implies management.
  // For robustness, we ensure it's listening.
  if (!httpServer.listening) {
    httpServer.listen(port, () => {
        console.log(`Backend server with Hono & Socket.IO is running on http://localhost:${port}`);
        const mediasoupListenIpInfo = mediasoupAppConfig.mediasoup.webRtcTransport.listenIps[0];
        console.log(`Mediasoup listening on IP: ${mediasoupListenIpInfo.ip} announced as ${mediasoupListenIpInfo.announcedIp || 'auto-detected'}`);
        console.log(`Mediasoup RTC port range: ${mediasoupAppConfig.mediasoup.workerSettings.rtcMinPort}-${mediasoupAppConfig.mediasoup.workerSettings.rtcMaxPort}`);
    });
  } else { // If `serve` already started listening
    console.log(`Backend server with Hono & Socket.IO is running on http://localhost:${port}`);
    const mediasoupListenIpInfo = mediasoupAppConfig.mediasoup.webRtcTransport.listenIps[0];
    console.log(`Mediasoup listening on IP: ${mediasoupListenIpInfo.ip} announced as ${mediasoupListenIpInfo.announcedIp || 'auto-detected'}`);
    console.log(`Mediasoup RTC port range: ${mediasoupAppConfig.mediasoup.workerSettings.rtcMinPort}-${mediasoupAppConfig.mediasoup.workerSettings.rtcMaxPort}`);
  }
}

run().catch(error => {
  console.error('Failed to start the server:', error);
  process.exit(1);
});