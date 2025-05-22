'use client';

import React, { useEffect, useRef, useState } from 'react';
import Hls, { Events, ErrorTypes, ErrorData } from 'hls.js';

const HLS_STREAM_URL = 'http://localhost:3001/hls/stream.m3u8';

export default function WatchPage() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(HLS_STREAM_URL);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                console.log('HLS manifest parsed, starting playback');
                video.play().catch(err => console.error('Playback failed:', err));
            });
            hls.on(Events.ERROR, (eventName: Events.ERROR, data: ErrorData) => {
                console.error('HLS Error:', data.type, data.details);
                if (data.fatal) {
                    switch (data.type) {
                        case ErrorTypes.NETWORK_ERROR:
                            setErrorMessage('Network error: Failed to load HLS stream. Ensure a stream is active on the /stream page.');
                            break;
                        case ErrorTypes.MEDIA_ERROR:
                            setErrorMessage('Media error: Incompatible stream format.');
                            break;
                        default:
                            setErrorMessage('An unknown HLS error occurred.');
                    }
                    hls.destroy();
                }
            });
            return () => hls.destroy();
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = HLS_STREAM_URL;
            video.addEventListener('loadedmetadata', () => {
                video.play().catch(err => console.error('Playback failed:', err));
            });
        } else {
            setErrorMessage('HLS is not supported on this browser.');
        }
    }, []);

    return (
        <div className="p-4">
            <h1 className="text-3xl font-bold mb-6">Watch Live Stream</h1>
            {errorMessage && (
                <p className="text-red-500 mb-4">{errorMessage}</p>
            )}
            <div className="bg-black rounded-lg shadow overflow-hidden">
                <video
                    id="hlsPlayer"
                    ref={videoRef}
                    controls
                    className="w-full h-auto"
                ></video>
            </div>
        </div>
    );
}