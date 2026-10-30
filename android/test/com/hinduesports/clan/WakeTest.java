package com.hinduesports.clan;

import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Plain-Java test of the "wait until the sleeping server is awake" logic (run on a computer, no phone needed). */
public class WakeTest {
    static int passed = 0, failed = 0;

    static void check(String name, boolean ok, String detail) {
        if (ok) passed++; else failed++;
        System.out.println("  " + (ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + detail));
    }

    static final String MANIFEST = "{\"name\":\"HINDU ESPORTS\",\"short_name\":\"HINDU ESPORTS\",\"start_url\":\"/?source=pwa\"}";
    static final String INTERSTITIAL = "<html><body>Your free instance is waking up...</body></html>";

    interface Behaviour { void handle(int attempt, com.sun.net.httpserver.HttpExchange ex) throws Exception; }

    static HttpServer serve(final Behaviour b, final AtomicInteger attempts) throws Exception {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        s.createContext("/", ex -> {
            int n = attempts.incrementAndGet();
            try { b.handle(n, ex); } catch (Exception e) { try { ex.close(); } catch (Exception ignore) {} }
        });
        s.setExecutor(java.util.concurrent.Executors.newCachedThreadPool(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; }));
        s.start();
        return s;
    }

    static void reply(com.sun.net.httpserver.HttpExchange ex, int code, String body) throws Exception {
        byte[] bytes = body.getBytes("UTF-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream o = ex.getResponseBody()) { o.write(bytes); }
    }

    static String url(HttpServer s) { return "http://127.0.0.1:" + s.getAddress().getPort() + "/manifest.webmanifest"; }

    static final ServerWake.Cancel NEVER = () -> false;

    public static void main(String[] args) throws Exception {
        // 1) awake already
        AtomicInteger n = new AtomicInteger();
        HttpServer s = serve((i, ex) -> reply(ex, 200, MANIFEST), n);
        long t0 = System.currentTimeMillis();
        int r = ServerWake.await(url(s), 5000, 1000, 1000, 300, NEVER);
        check("awake server -> READY at once", r == ServerWake.READY && n.get() == 1 && System.currentTimeMillis() - t0 < 1000, r + " attempts=" + n.get());
        s.stop(0);

        // 2) host answers 503 while waking, then 200
        n = new AtomicInteger();
        s = serve((i, ex) -> reply(ex, i <= 2 ? 503 : 200, i <= 2 ? "waking" : MANIFEST), n);
        t0 = System.currentTimeMillis();
        r = ServerWake.await(url(s), 8000, 1000, 1000, 200, NEVER);
        long took = System.currentTimeMillis() - t0;
        check("503, 503, 200 -> READY after retries", r == ServerWake.READY && n.get() == 3 && took >= 380, r + " attempts=" + n.get() + " ms=" + took);
        s.stop(0);

        // 3) host shows its own "waking up" page with status 200 first
        n = new AtomicInteger();
        s = serve((i, ex) -> reply(ex, 200, i <= 2 ? INTERSTITIAL : MANIFEST), n);
        r = ServerWake.await(url(s), 8000, 1000, 1000, 100, NEVER);
        check("host's own waiting page (200) is not mistaken for the site", r == ServerWake.READY && n.get() == 3, r + " attempts=" + n.get());
        s.stop(0);

        // 4) request hangs (server still booting): bounded by the total time
        n = new AtomicInteger();
        s = serve((i, ex) -> Thread.sleep(8000), n);
        t0 = System.currentTimeMillis();
        r = ServerWake.await(url(s), 1500, 300, 300, 100, NEVER);
        took = System.currentTimeMillis() - t0;
        check("hanging server -> TIMED_OUT within the limit", r == ServerWake.TIMED_OUT && took < 2600 && n.get() >= 2, r + " ms=" + took + " attempts=" + n.get());
        s.stop(0);

        // 5) never becomes our page
        n = new AtomicInteger();
        s = serve((i, ex) -> reply(ex, 200, INTERSTITIAL), n);
        t0 = System.currentTimeMillis();
        r = ServerWake.await(url(s), 1200, 500, 500, 100, NEVER);
        took = System.currentTimeMillis() - t0;
        check("wrong page forever -> TIMED_OUT", r == ServerWake.TIMED_OUT && took < 2200, r + " ms=" + took);
        s.stop(0);

        // 6) no network at all: do not wait
        ServerSocket closed = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")); int port = closed.getLocalPort(); closed.close();
        t0 = System.currentTimeMillis();
        r = ServerWake.await("http://127.0.0.1:" + port + "/x", 20000, 1000, 1000, 500, NEVER);
        check("connection refused -> OFFLINE immediately", r == ServerWake.OFFLINE && System.currentTimeMillis() - t0 < 1500, r + "");
        t0 = System.currentTimeMillis();
        r = ServerWake.await("http://no-such-host.invalid/x", 20000, 1000, 1000, 500, NEVER);
        check("unknown host -> OFFLINE immediately", r == ServerWake.OFFLINE && System.currentTimeMillis() - t0 < 5000, r + " ms=" + (System.currentTimeMillis() - t0));

        // 7) user leaves while waiting
        n = new AtomicInteger();
        s = serve((i, ex) -> Thread.sleep(8000), n);
        final AtomicBoolean stop = new AtomicBoolean();
        new Thread(() -> { try { Thread.sleep(400); } catch (Exception e) {} stop.set(true); }).start();
        t0 = System.currentTimeMillis();
        r = ServerWake.await(url(s), 30000, 2000, 2000, 200, stop::get);
        took = System.currentTimeMillis() - t0;
        check("cancel while waiting -> CANCELLED quickly", r == ServerWake.CANCELLED && took < 2600, r + " ms=" + took);
        s.stop(0);

        // 8) cancelled before the first attempt
        r = ServerWake.await("http://127.0.0.1:1/x", 5000, 500, 500, 100, () -> true);
        check("already cancelled -> CANCELLED", r == ServerWake.CANCELLED, r + "");

        System.out.println(passed + " passed, " + failed + " failed");
        System.exit(failed == 0 ? 0 : 1);
    }
}
