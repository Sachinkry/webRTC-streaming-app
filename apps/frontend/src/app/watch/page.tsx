export default function WatchPage() {
    return (
      <div>
        <h1 className="text-3xl font-bold mb-6">Watch Live Stream</h1>
        <p className="mb-4">This is where the HLS live stream will be played.</p>
        <div className="bg-black rounded-lg shadow overflow-hidden">
          <video id="hlsPlayer" controls className="w-full h-auto"></video>
        </div>
        <p className="mt-4 text-sm text-gray-400">
          Note: HLS player will be integrated in a later phase.
        </p>
      </div>
    );
  }
  