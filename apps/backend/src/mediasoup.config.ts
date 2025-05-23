import { types as mediasoupTypes } from 'mediasoup';

export const config = {
  mediasoup: {
    // Worker settings
    workerSettings: {
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
      logLevel: 'warn' as const,
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp',
      ] as mediasoupTypes.WorkerLogTag[],
    },
    // Router settings
    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/VP9',
          clockRate: 90000,
          parameters: {
            'profile-id': 2,
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
      ] as mediasoupTypes.RtpCodecCapability[],
    },
    // WebRtcTransport settings
    webRtcTransport: {
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: '127.0.0.1', // Replace with your public IP in production
        },
      ] as mediasoupTypes.TransportListenIp[],
      maxIncomingBitrate: 1500000,
      initialAvailableOutgoingBitrate: 1000000,
      enableUdp: true,
      enableTcp: false,
      preferUdp: true,
    },
    // PlainTransport settings for FFMPEG
    plainTransport: {
      listenIp: {
        ip: '0.0.0.0',
        announcedIp: '127.0.0.1',
      } as mediasoupTypes.TransportListenIp,
      maxSctpMessageSize: 262144,
    },
  } as const,
  // HLS settings
  hls: {
    outputDir: './public/hls',
    segmentDuration: 4,
    playlistLength: 10,
  },
};