package app.framelink.camera;

import org.json.JSONObject;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.concurrent.Semaphore;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;

final class LinkServer implements AutoCloseable {
    interface Listener {
        void connected(boolean connected);
        void command(JSONObject object);
        void requestKeyframe();
        void failed(String error);
    }

    private final SSLServerSocket server;
    private final Pairing pairing;
    private final Listener listener;
    private final Semaphore handshakes = new Semaphore(4);
    private final java.util.Set<SSLSocket> sockets = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private volatile Peer peer;
    private boolean closed;

    LinkServer(int port, Pairing pairing, Listener listener) throws IOException {
        this.pairing = pairing;
        this.listener = listener;
        server = (SSLServerSocket) pairing.context.getServerSocketFactory().createServerSocket();
        server.setEnabledProtocols(Arrays.stream(server.getSupportedProtocols())
            .filter(protocol -> protocol.equals("TLSv1.3") || protocol.equals("TLSv1.2"))
            .toArray(String[]::new));
        server.setReuseAddress(true);
        try {
            server.bind(new InetSocketAddress(port), 8);
        } catch (IOException e) {
            server.close();
            throw e;
        }
    }

    void start() {
        new Thread(this::accept, "FrameLink accept").start();
    }

    private void accept() {
        while (!server.isClosed()) {
            try {
                SSLSocket socket = (SSLSocket) server.accept();
                if (!handshakes.tryAcquire()) {
                    socket.close();
                    continue;
                }
                synchronized (this) {
                    if (closed) {
                        socket.close();
                        handshakes.release();
                        return;
                    }
                    sockets.add(socket);
                }
                new Thread(() -> authenticate(socket), "FrameLink TLS").start();
            } catch (IOException e) {
                if (!server.isClosed()) listener.failed("Ошибка сокета: " + e.getMessage());
                return;
            }
        }
    }

    private void authenticate(SSLSocket socket) {
        Peer active = null;
        try {
            socket.setTcpNoDelay(true);
            socket.setSendBufferSize(128 * 1024);
            socket.setSoTimeout(5000);
            socket.startHandshake();
            var input = new BufferedInputStream(socket.getInputStream());
            var output = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream(), 32 * 1024));
            JSONObject hello = read(input);
            if (hello.optInt("version") != 1 || !MessageDigest.isEqual(
                pairing.secret.getBytes(StandardCharsets.US_ASCII),
                hello.optString("secret").getBytes(StandardCharsets.US_ASCII))) {
                write(output, Wire.json(Wire.json("denied")));
                return;
            }
            synchronized (this) {
                if (closed) return;
                if (peer != null) {
                    write(output, Wire.json(Wire.json("busy")));
                    return;
                }
                active = new Peer(socket, output);
                peer = active;
                active.offer(Wire.json(Wire.json("ready")));
                listener.connected(true);
            }
            socket.setSoTimeout(12000);
            Peer session = active;
            new Thread(session::writeLoop, "FrameLink stream").start();
            while (!socket.isClosed()) {
                JSONObject command = read(input);
                if ("ping".equals(command.optString("type"))) session.offer(Wire.json(Wire.json("pong")));
                else listener.command(command);
            }
        } catch (Exception ignored) {
            // A timeout, invalid request or disconnection only ends this peer.
        } finally {
            synchronized (this) {
                if (active != null && peer == active) {
                    peer = null;
                    if (!closed) listener.connected(false);
                }
            }
            if (active != null) active.stop();
            else closeSocket(socket);
            sockets.remove(socket);
            handshakes.release();
        }
    }

    void send(Wire.Packet packet) {
        Peer current = peer;
        if (current != null && current.offer(packet)) listener.requestKeyframe();
    }

    void resetVideo(JSONObject configuration) {
        Peer current = peer;
        if (current != null) current.resetVideo(Wire.json(configuration));
    }

    @Override public synchronized void close() {
        closed = true;
        try { server.close(); } catch (IOException ignored) {}
        if (peer != null) peer.stop();
        for (SSLSocket socket : sockets) closeSocket(socket);
    }

    private static JSONObject read(BufferedInputStream input) throws Exception {
        var line = new ByteArrayOutputStream();
        while (line.size() < 4096) {
            int value = input.read();
            if (value < 0) throw new EOFException();
            if (value == '\n') return new JSONObject(line.toString("UTF-8"));
            line.write(value);
        }
        throw new IOException("Command too long");
    }

    private static void write(DataOutputStream output, Wire.Packet packet) throws IOException {
        output.writeByte(packet.type());
        output.writeInt(packet.data().length);
        output.writeLong(packet.timestamp());
        output.write(packet.data());
        output.flush();
    }

    private static void closeSocket(SSLSocket socket) {
        try { socket.close(); } catch (IOException ignored) {}
    }

    private static final class Peer {
        private final SSLSocket socket;
        private final DataOutputStream output;
        private final ArrayDeque<Wire.Packet> queue = new ArrayDeque<>();
        private boolean waitingForKey = true;
        private boolean stopped;

        Peer(SSLSocket socket, DataOutputStream output) {
            this.socket = socket;
            this.output = output;
        }

        synchronized boolean offer(Wire.Packet packet) {
            if (stopped) return false;
            int type = packet.type();
            if (type == Wire.DELTA && waitingForKey) return false;
            boolean keyNeeded = false;
            if (queue.size() >= 10) {
                boolean removedVideo = queue.removeIf(p -> p.type() == Wire.DELTA || p.type() == Wire.KEY);
                queue.removeIf(p -> p.type() == Wire.PCM);
                waitingForKey |= removedVideo;
                keyNeeded = removedVideo && type != Wire.KEY;
                if (waitingForKey && type == Wire.DELTA) return keyNeeded;
                if (queue.size() >= 32) {
                    stop();
                    return false;
                }
            }
            if (type == Wire.KEY) waitingForKey = false;
            queue.addLast(packet);
            notifyAll();
            return keyNeeded;
        }

        synchronized void resetVideo(Wire.Packet config) {
            if (stopped) return;
            queue.removeIf(p -> p.type() == Wire.DELTA || p.type() == Wire.KEY);
            waitingForKey = true;
            offer(config);
        }

        private synchronized Wire.Packet next() throws InterruptedException {
            while (queue.isEmpty() && !stopped) wait();
            return stopped ? null : queue.removeFirst();
        }

        void writeLoop() {
            try {
                Wire.Packet packet;
                while ((packet = next()) != null) write(output, packet);
            } catch (IOException | InterruptedException ignored) {
                stop();
            }
        }

        synchronized void stop() {
            if (stopped) return;
            stopped = true;
            queue.clear();
            notifyAll();
            closeSocket(socket);
        }
    }
}
