import Image from "next/image";

export default function Home() {
  return (
    <div className="text-center py-10">
      <h1 className="text-4xl font-bold mb-4">Welcome to WebRTC Streamer</h1>
      <p className="text-lg mb-8">Choose an option below to get started.</p>
      <div className="space-x-4">
        <a
          href="/stream"
          className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-lg text-lg"
        >
          Go to Stream Page
        </a>
        <a
          href="/watch"
          className="bg-green-500 hover:bg-green-700 text-white font-bold py-3 px-6 rounded-lg text-lg"
        >
          Go to Watch Page
        </a>
      </div>
    </div>
  );
}
