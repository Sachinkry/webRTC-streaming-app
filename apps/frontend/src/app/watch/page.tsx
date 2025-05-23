'use client';

import React, { useEffect, useRef, useState } from 'react';
import Hls, { Events, ErrorTypes, ErrorData } from 'hls.js';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

export default function WatchPage() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [streamId, setStreamId] = useState<string | null>(null);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        // Get the stream ID from the URL
        const urlParams = new URLSearchParams(window.location.search);
        const id = urlParams.get('id');
        if (!id) {
            setErrorMessage('No stream ID provided. Please go to the stream page first.');
            return;
        }
        setStreamId(id);

        if (Hls.isSupported()) {
            const hls = new Hls({
                debug: true,
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 0
            });

            const streamUrl = `${BACKEND_URL}/hls/${id}/stream.m3u8`;
            console.log('Loading HLS stream from:', streamUrl);
            
            hls.loadSource(streamUrl);
            hls.attachMedia(video);
            
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                console.log('HLS manifest parsed, starting playback');
                video.play().catch(err => {
                    console.error('Playback failed:', err);
                    setErrorMessage('Failed to start playback. Please try refreshing the page.');
                });
            });

            hls.on(Events.ERROR, (eventName: Events.ERROR, data: ErrorData) => {
                console.error('HLS Error:', data.type, data.details);
                if (data.fatal) {
                    switch (data.type) {
                        case ErrorTypes.NETWORK_ERROR:
                            if (data.details === 'manifestLoadTimeOut') {
                                setErrorMessage('Stream not found or not yet available. Please ensure someone is streaming.');
                            } else {
                                setErrorMessage('Network error: Failed to load HLS stream. Please check your connection.');
                            }
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

            return () => {
                console.log('Cleaning up HLS instance');
                hls.destroy();
            };
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // For Safari
            const streamUrl = `${BACKEND_URL}/hls/${id}/stream.m3u8`;
            video.src = streamUrl;
            video.addEventListener('loadedmetadata', () => {
                video.play().catch(err => {
                    console.error('Playback failed:', err);
                    setErrorMessage('Failed to start playback. Please try refreshing the page.');
                });
            });
        } else {
            setErrorMessage('HLS is not supported on this browser.');
        }
    }, []);

    return (
        <div className="p-4">
            <h1 className="text-3xl font-bold mb-6">Watch Live Stream</h1>
            {errorMessage && (
                <div className="bg-red-500 text-white p-4 rounded-lg mb-4">
                    <p>{errorMessage}</p>
                    {errorMessage.includes('not found') && (
                        <a href="/stream" className="text-white underline mt-2 inline-block">
                            Go to Stream Page
                        </a>
                    )}
                </div>
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