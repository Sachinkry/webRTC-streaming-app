'use client';

import React, { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import { types as mediasoupClientTypes } from 'mediasoup-client';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

export default function StreamPage() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoContainerRef = useRef<HTMLDivElement>(null);
  const deviceRef = useRef<Device | null>(null);

  const [socket, setSocket] = useState<Socket | null>(null);
  const [mediasoupDevice, setMediasoupDevice] = useState<Device | null>(null);
  const [sendTransport, setSendTransport] = useState<mediasoupClientTypes.Transport | null>(null);
  const [recvTransport, setRecvTransport] = useState<mediasoupClientTypes.Transport | null>(null);
  const [producersMap, setProducersMap] = useState<Map<string, mediasoupClientTypes.Producer>>(new Map());
  const [consumersMap, setConsumersMap] = useState<Map<string, { consumer: mediasoupClientTypes.Consumer, peerId: string }>>(new Map());
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());

  // Effect for Socket.IO connection lifecycle
  useEffect(() => {
    const newSocketInstance = io(BACKEND_URL);
    setSocket(newSocketInstance); // Set socket state for UI and other dependent effects

    newSocketInstance.on('connect', () => {
      console.log('Socket connected (newSocketInstance.id):', newSocketInstance.id);
      initializeMedia(newSocketInstance); // Initialize Mediasoup device and transports
    });

    newSocketInstance.on('connect_error', (error) => {
      console.error('Socket connection error:', error.message);
    });

    newSocketInstance.on('disconnect', () => {
      console.log('Socket disconnected. Cleaning up resources.');
      // Close and nullify transports
      sendTransport?.close();
      recvTransport?.close();
      setSendTransport(null);
      setRecvTransport(null);

      // Close producers and consumers
      producersMap.forEach(p => p.close());
      consumersMap.forEach(c => c.consumer.close());
      setProducersMap(new Map());
      setConsumersMap(new Map());
      setRemoteStreams(new Map());

      // Reset Mediasoup device related state
      deviceRef.current = null;
      setMediasoupDevice(null);
    });

    return () => {
      console.log('Cleaning up main socket connection effect.');
      newSocketInstance.disconnect();
      // Ensure all resources are closed on component unmount or effect re-run (if deps changed)
      sendTransport?.close();
      recvTransport?.close();
      producersMap.forEach(p => p.close());
      consumersMap.forEach(c => c.consumer.close());
    };
  }, []); // Runs once on mount to establish and manage the socket connection

  // Effect for Mediasoup producer/consumer event handling
  useEffect(() => {
    // Only set up listeners if socket is connected, device is loaded, and recvTransport is ready
    if (socket && mediasoupDevice?.loaded && recvTransport) {
      console.log('Prerequisites met: Setting up new-producer and existing-producers listeners.');

      const handleNewProducer = async (data: { peerId: string; producerId: string; kind: 'audio' | 'video' }) => {
        console.log('Received "new-producer" event:', data);
        if (data.peerId === socket.id) {
          console.log('Ignoring own new producer notification.');
          return;
        }
        // Prerequisites are met due to the if condition of this useEffect
        await consumeRemoteProducer(data.producerId, data.peerId);
      };

      const handleExistingProducers = (producers: Array<{ peerId: string; producerId: string; kind: 'audio' | 'video' }>) => {
        console.log('Received "existing-producers" event:', producers);
        producers.forEach(async (producerData) => {
          if (producerData.peerId === socket.id) {
            console.log(`Ignoring own existing producer: ${producerData.producerId}`);
            return;
          }
          await consumeRemoteProducer(producerData.producerId, producerData.peerId);
        });
      };

      // Server message handlers
      socket.on('consumer-closed', ({ consumerId, remotePeerId }: { consumerId: string, remotePeerId: string }) => {
        console.log(`Consumer ${consumerId} for remote peer ${remotePeerId} closed because producer ended.`);
        const consumerEntry = consumersMap.get(consumerId);
        if (consumerEntry) {
          consumerEntry.consumer.close();
          const updatedConsumersMap = new Map(consumersMap);
          updatedConsumersMap.delete(consumerId);
          setConsumersMap(updatedConsumersMap);

          let peerHasOtherConsumers = false;
          updatedConsumersMap.forEach(c => {
            if (c.peerId === remotePeerId) peerHasOtherConsumers = true;
          });

          if (!peerHasOtherConsumers) {
            const updatedRemoteStreams = new Map(remoteStreams);
            updatedRemoteStreams.delete(remotePeerId);
            setRemoteStreams(updatedRemoteStreams);
            console.log(`Removed video element for peer ${remotePeerId}`);
          }
        }
      });

      socket.on('peer-disconnected', ({ peerId }: { peerId: string }) => {
        console.log(`Peer ${peerId} disconnected. Cleaning up their consumers and streams.`);
        const updatedConsumersMap = new Map(consumersMap);
        const updatedRemoteStreams = new Map(remoteStreams);
        let consumersToDelete: string[] = [];

        consumersMap.forEach((consumerEntry, consumerId) => {
          if (consumerEntry.peerId === peerId) {
            consumerEntry.consumer.close();
            consumersToDelete.push(consumerId);
          }
        });
        consumersToDelete.forEach(id => updatedConsumersMap.delete(id));
        updatedRemoteStreams.delete(peerId);

        setConsumersMap(updatedConsumersMap);
        setRemoteStreams(updatedRemoteStreams);
        console.log(`Cleaned up resources for disconnected peer ${peerId}`);
      });


      socket.on('new-producer', handleNewProducer);
      socket.on('existing-producers', handleExistingProducers);

      // It's possible the 'existing-producers' event was emitted by the server
      // before this effect ran (if device/transport setup was slow).
      // To handle this, you might need to explicitly request existing producers
      // from the server here if this is the first time these prerequisites are met.
      // Example: socket.emit('getInitialProducers', (producers) => handleExistingProducers(producers));
      // This requires a new server-side handler. For now, we assume the timing might align
      // or subsequent 'new-producer' events will cover new peers.

      return () => {
        console.log('Cleaning up new-producer and existing-producers listeners.');
        if (socket) { // Ensure socket still exists
            socket.off('new-producer', handleNewProducer);
            socket.off('existing-producers', handleExistingProducers);
            socket.off('consumer-closed');
            socket.off('peer-disconnected');
        }
      };
    } else {
      console.log('Deferred producer/consumer event listener setup. Waiting for prerequisites:', {
        socketReady: !!socket,
        deviceLoaded: !!mediasoupDevice?.loaded,
        recvTransportReady: !!recvTransport,
      });
    }
  }, [socket, mediasoupDevice, recvTransport]); // Dependencies ensure this effect re-runs when these crucial states change

  const initializeMedia = async (currentActiveSocket: Socket) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const device = new Device();
      currentActiveSocket.emit('getRouterRtpCapabilities', async (routerRtpCapabilities: mediasoupClientTypes.RtpCapabilities) => {
        if (!routerRtpCapabilities) {
          console.error('Failed to get router RTP capabilities');
          return;
        }
        try {
          await device.load({ routerRtpCapabilities });
          console.log('Mediasoup device loaded with router capabilities');
          deviceRef.current = device; // Set the ref
          setMediasoupDevice(device); // Set state to trigger dependent useEffect

          await createSendTransport(currentActiveSocket, device, stream);
          await createRecvTransport(currentActiveSocket, device); // This will set recvTransport state
        //   startCameraAndProduce();
        } catch (error) {
          console.error('Error loading Mediasoup device:', error);
          setMediasoupDevice(null); // Ensure state reflects failure
        }
      });
    } catch (error) {
      console.error('Error getting user media or initializing Mediasoup:', error);
      setMediasoupDevice(null); // Ensure state reflects failure
    }
  };

  const createSendTransport = async (currentActiveSocket: Socket, device: Device, stream: MediaStream) => {
    if (!currentActiveSocket || !device || !device.loaded) {
      console.error('Cannot create send transport: prerequisites not ready', {
        socketReady: !!currentActiveSocket,
        deviceReady: !!device,
        deviceLoaded: device?.loaded,
      });
      return;
    }
    currentActiveSocket.emit('createWebRtcTransport', { sender: true }, async (params: any) => {
      if (params.error) {
        console.error('Error creating send transport:', params.error);
        setSendTransport(null); // Reflect failure
        return;
      }
      console.log('Send transport created on server:', params.id);
      const transport = device.createSendTransport(params);
      
      // Set up transport event listeners BEFORE producing media
      transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          await currentActiveSocket.emit('connectWebRtcTransport', {
            transportId: transport.id,
            dtlsParameters,
          }, callback);
        } catch (error: any) {
          errback(error instanceof Error ? error : new Error(String(error)));
        }
      });

      transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          await currentActiveSocket.emit('produce', {
            transportId: transport.id,
            kind,
            rtpParameters,
            appData,
          }, ({ id }: { id: string }) => {
            callback({ id });
          });
        } catch (error: any) {
          errback(error instanceof Error ? error : new Error(String(error)));
        }
      });

      transport.on('connectionstatechange', (state) => {
        console.log('Send transport connection state:', state);
        if (state === 'closed') {
          transport.close();
        }
      });

      setSendTransport(transport); // Set state
      await startCameraAndProduce(transport, stream);
    });
  };

  const createRecvTransport = async (currentActiveSocket: Socket, device: Device) => {
    if (!currentActiveSocket || !device || !device.loaded) {
      console.error('Cannot create recv transport: prerequisites not ready', {
        socketReady: !!currentActiveSocket,
        deviceReady: !!device,
        deviceLoaded: device?.loaded,
      });
      return;
    }
    currentActiveSocket.emit('createWebRtcTransport', { sender: false }, async (params: any) => {
      if (params.error) {
        console.error('Error creating recv transport:', params.error);
        setRecvTransport(null); // Reflect failure
        return;
      }
      console.log('Recv transport created on server:', params.id);
      const transport = device.createRecvTransport(params);
      setRecvTransport(transport); // Set state to trigger dependent useEffect

      transport.on('connect', ({ dtlsParameters }, callback, errback) => { /* ... */ });
      transport.on('connectionstatechange', (state) => { /* ... */ });
    });
  };

  const startCameraAndProduce = async (
    sendTransport: mediasoupClientTypes.Transport,
    stream: MediaStream
  ) => {
    try {
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
  
      const videoProducer = await sendTransport.produce({
        track: videoTrack,
        appData: { mediaTag: 'cam-video' },
      });
  
      const audioProducer = await sendTransport.produce({
        track: audioTrack,
        appData: { mediaTag: 'cam-audio' },
      });
  
      const videoElement = document.getElementById('localVideo') as HTMLVideoElement;
      if (videoElement) {
        videoElement.srcObject = stream;
        videoElement.play();
      }
  
      console.log(
        'Successfully produced video and audio tracks:',
        videoProducer.id,
        audioProducer.id
      );
    } catch (err) {
      console.error('Error getting user media or producing:', err);
    }
  };
  

  const consumeRemoteProducer = async (producerId: string, peerId: string) => {
    // This check should now pass because the calling useEffect waits for these.
    // deviceRef.current is used here directly as it's set before mediasoupDevice state might reflect.
    // Though mediasoupDevice.loaded in the useEffect condition covers deviceRef.current being ready.
    if (!socket || !deviceRef.current || !recvTransport || !deviceRef.current.loaded) {
      console.error('CRITICAL: consumeRemoteProducer called when prerequisites were not ready. This should not happen with the new useEffect structure.', {
        socketReady: !!socket,
        deviceReady: !!deviceRef.current,
        recvTransportReady: !!recvTransport,
        deviceLoaded: deviceRef.current?.loaded,
      });
      return;
    }

    let alreadyConsuming = false;
    consumersMap.forEach(cEntry => {
      if (cEntry.consumer.producerId === producerId && cEntry.peerId === peerId) {
        alreadyConsuming = true;
      }
    });
    if (alreadyConsuming) {
      console.log(`Already consuming producer ${producerId} from peer ${peerId}`);
      return;
    }

    console.log(`Attempting to consume producer ${producerId} from peer ${peerId} using transport ${recvTransport.id}`);
    socket.emit('consume', {
      producerId,
      rtpCapabilities: deviceRef.current.rtpCapabilities,
      transportId: recvTransport.id,
    }, async ({ id, kind, rtpParameters, error }: any) => {
      // ... (rest of the consumeRemoteProducer logic remains the same)
      if (error) {
        console.error(`Error consuming producer ${producerId}:`, error);
        return;
      }
      if (!id) {
        console.error(`Server did not return consumer id for producer ${producerId}`);
        return;
      }

      console.log(`Consumer created on server. Client side consumer id: ${id}, kind: ${kind}`);
      try {
        const consumer = await recvTransport.consume({
          id,
          producerId,
          kind,
          rtpParameters,
        });
        console.log(`Client-side consumer created for producer ${producerId}, track kind: ${consumer.track.kind}`);
        
        setConsumersMap(prev => new Map(prev).set(consumer.id, { consumer, peerId }));

        const { track } = consumer;
        let currentStream = remoteStreams.get(peerId);
        if (!currentStream) {
          currentStream = new MediaStream();
          setRemoteStreams(prev => new Map(prev).set(peerId, currentStream!));
        }
        currentStream.addTrack(track);

        socket.emit('resume-consumer', { consumerId: consumer.id }, (resumeErrorObj?: {error: string}) => {
          if (resumeErrorObj?.error) {
            console.error(`Error resuming consumer ${consumer.id} on server:`, resumeErrorObj.error);
          } else {
            console.log(`Consumer ${consumer.id} resumed on server.`);
          }
        });

        consumer.on('trackended', () => {
          console.log(`Remote track ended for consumer ${consumer.id} (peer ${peerId})`);
          consumer.close(); 
          const updatedConsumers = new Map(consumersMap);
          updatedConsumers.delete(consumer.id);
          setConsumersMap(updatedConsumers);

          const stream = remoteStreams.get(peerId);
          if (stream) {
            stream.removeTrack(track);
            if (stream.getTracks().length === 0) {
              const updatedStreams = new Map(remoteStreams);
              updatedStreams.delete(peerId);
              setRemoteStreams(updatedStreams);
              console.log(`Removed video element for peer ${peerId} as all tracks ended.`);
            }
          }
        });
        consumer.on('transportclose', () => { /* ... */ });
      } catch (consumeError) {
        console.error(`Error creating client-side consumer for producer ${producerId}:`, consumeError);
      }
    });
  };
  // ... (rest of the component, including JSX return) ...
  return (
    <div className="p-4">
      <h1 className="text-3xl font-bold mb-6 text-center">Stream Page - WebRTC</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-gray-800 p-4 rounded-lg shadow-xl">
          <h2 className="text-xl font-semibold mb-3 text-blue-400">My Video</h2>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-auto bg-black rounded aspect-video"
          ></video>
        </div>
        
        <div className="bg-gray-800 p-4 rounded-lg shadow-xl">
          <h2 className="text-xl font-semibold mb-3 text-green-400">Remote Videos</h2>
          <div ref={remoteVideoContainerRef} id="remote-videos-container" className="space-y-4">
            {Array.from(consumersMap.entries())
              .filter(([consumerId, consumerEntry]) => consumerEntry.consumer.kind === 'video') // Only render video consumers
              .map(([consumerId, consumerEntry]) => (
                <div key={consumerId} className="bg-gray-700 p-2 rounded">
                  <p className="text-sm text-gray-300 mb-1">Remote Peer: {consumerEntry.peerId.substring(0, 6)}...</p>
                  <video
                    autoPlay
                    playsInline
                    className="w-full h-auto bg-black rounded aspect-video"
                    ref={(videoElement) => {
                      if (videoElement && consumerEntry.consumer.track) {
                        // Set the srcObject directly to the consumer's track
                        const remoteStream = new MediaStream([consumerEntry.consumer.track]);
                        videoElement.srcObject = remoteStream;
                      }
                    }}
                  ></video>
                </div>
              ))}
            {consumersMap.size === 0 && (
              <p className="text-gray-500">No remote streams yet...</p>
            )}
          </div>
        </div>
      </div>
      <div className="mt-8 p-4 bg-gray-800 rounded-lg shadow-xl">
        <h3 className="text-lg font-semibold mb-2 text-purple-400">Connection Status & Debug</h3>
        <p>Socket ID: {socket?.id || 'Not connected'}</p>
        <p>Mediasoup Device Loaded: {mediasoupDevice?.loaded ? 'Yes' : 'No'}</p>
        <p>Send Transport ID: {sendTransport?.id || 'N/A'}</p>
        <p>Recv Transport ID: {recvTransport?.id || 'N/A'}</p>
        <p>Local Producers: {producersMap.size}</p>
        <p>Remote Consumers: {consumersMap.size}</p>
      </div>
    </div>
  );
}