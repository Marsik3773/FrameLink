package app.framelink.camera;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.util.Log;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;

final class Discovery implements AutoCloseable {
    private static final int PORT = 47470;
    private static final String PREFIX = "FrameLink/2 ";
    private final DatagramSocket socket;
    private final WifiManager.MulticastLock wifi;
    private final int streamPort;
    private final BooleanSupplier busy;

    private final NsdManager nsd;
    private boolean closed;
    private final NsdManager.RegistrationListener registration = new NsdManager.RegistrationListener() {
        public void onServiceRegistered(NsdServiceInfo info) {
            synchronized (Discovery.this) { if (closed) unregister(); }
        }
        public void onServiceUnregistered(NsdServiceInfo info) { }
        public void onRegistrationFailed(NsdServiceInfo info, int code) { Log.d("FrameLink", "DNS-SD registration " + code); }
        public void onUnregistrationFailed(NsdServiceInfo info, int code) { Log.d("FrameLink", "DNS-SD removal " + code); }
    };

    private void unregister() {
        try { if (nsd != null) nsd.unregisterService(registration); }
        catch (RuntimeException error) { Log.d("FrameLink", "DNS-SD removal", error); }
    }

    Discovery(Context context, int streamPort, BooleanSupplier busy) throws IOException {
        this.streamPort = streamPort;
        this.busy = busy;
        socket = new DatagramSocket(null);
        try {
            socket.setReuseAddress(true);
            socket.bind(new InetSocketAddress(PORT));
        } catch (IOException error) {
            socket.close();
            throw error;
        }
        WifiManager manager = context.getApplicationContext().getSystemService(WifiManager.class);
        wifi = manager == null ? null : manager.createMulticastLock("FrameLink discovery");
        if (wifi != null) {
            try { wifi.acquire(); } catch (RuntimeException error) { Log.d("FrameLink", "Discovery Wi-Fi lock", error); }
        }
        nsd = context.getSystemService(NsdManager.class);
        if (nsd != null) {
            NsdServiceInfo info = new NsdServiceInfo();
            info.setServiceName("FrameLink " + Build.MODEL);
            info.setServiceType("_framelink._tcp.");
            info.setPort(streamPort);
            info.setAttribute("model", Build.MODEL);
            try { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration); }
            catch (RuntimeException error) { Log.d("FrameLink", "DNS-SD unavailable", error); }
        }
        new Thread(this::respond, "FrameLink discovery").start();
    }

    static boolean local(InetAddress address) {
        return address.isLoopbackAddress() || address.isSiteLocalAddress() || address.isLinkLocalAddress()
            || ((address.getAddress()[0] & 0xfe) == 0xfc && !(address instanceof Inet4Address));
    }

    private void respond() {
        byte[] buffer = new byte[128];
        DatagramPacket request = new DatagramPacket(buffer, buffer.length);
        while (!socket.isClosed()) {
            try {
                request.setLength(buffer.length);
                socket.receive(request);
                if (!local(request.getAddress())) continue;
                String query = new String(buffer, 0, request.getLength(), StandardCharsets.US_ASCII);
                if (!query.startsWith(PREFIX)) continue;
                String nonce = query.substring(PREFIX.length());
                if (!nonce.matches("[0-9a-f]{24}")) continue;
                var reply = Wire.json("phone");
                Wire.put(reply, "nonce", nonce);
                Wire.put(reply, "name", Build.MODEL);
                Wire.put(reply, "port", streamPort);
                Wire.put(reply, "busy", busy.getAsBoolean());
                byte[] data = reply.toString().getBytes(StandardCharsets.UTF_8);
                socket.send(new DatagramPacket(data, data.length, request.getSocketAddress()));
            } catch (IOException error) {
                if (!socket.isClosed()) Log.d("FrameLink", "Phone discovery", error);
            }
        }
    }

    @Override public synchronized void close() {
        closed = true;
        unregister();
        socket.close();
        if (wifi != null && wifi.isHeld()) wifi.release();
    }
}
