// apps/backend/src/mediasoup.config.ts
import os from 'os';
import { types as mediasoupTypes } from 'mediasoup';

export const config = {
  // Node environment
  nodeEnv: process.env.NODE_ENV || 'development',

  // Mediasoup settings
  mediasoup: {
    // Number of mediasoup workers to launch.
    // Defaults to number of CPU cores.
    numWorkers: Object.keys(os.cpus()).length,
    workerSettings: {
      logLevel: 'warn' as mediasoupTypes.WorkerLogLevel,
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
        // 'rtx',
        // 'bwe',
        // 'score',
        // 'simulcast',
        // 'svc'
      ] as mediasoupTypes.WorkerLogTag[],
      rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '20000'),
      rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '20100'),
    },
    router: {
      // RtpCodecCapability[]
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
            'profile-level-id': '4d0032', // '42e01f' (constrained baseline) or '4d0032' (main profile)
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
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
          ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP, // Will be overridden by actual IP if not set
        },
      ],
      initialAvailableOutgoingBitrate: 1000000,
      minimumAvailableOutgoingBitrate: 600000,
      maxSctpMessageSize: 262144, // For DataChannels if you use them
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    },
  },
} as const;
