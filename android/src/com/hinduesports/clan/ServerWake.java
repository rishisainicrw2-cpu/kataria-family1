package com.hinduesports.clan;

import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import javax.net.ssl.SSLException;

/**
 * Free hosting puts the clan server to sleep when nobody has used it for a while, and the first request
 * wakes it up (up to about a minute). Opening the site during that time shows a blank white screen.
 * This class asks the server for a tiny file again and again until it answers properly, so the app can
 * show its own "starting" screen and then open a page that is already ready.
 *
 * It uses no Android classes, so it is tested on a normal Java machine (android/test/WakeTest.java).
 */
final class ServerWake {
    /** The site answered with its own page. */
    static final int READY = 1;
    /** No network (cannot reach the host at all): do not wait, just open the app. */
    static final int OFFLINE = 2;
    /** Still not awake when the time ran out: open the app anyway. */
    static final int TIMED_OUT = 3;
    /** The caller stopped waiting. */
    static final int CANCELLED = 4;
    /** Something unexpected (for example a wrong phone clock breaking https): do not wait, just open the app. */
    static final int UNSURE = 5;

    interface Cancel {
        boolean isCancelled();
    }

    private ServerWake() {
    }

    /**
     * @param checkUrl         a small file of the site; its body must contain {@code "short_name"} (the web app manifest)
     * @param totalMs          give up waiting after this long
     * @param connectTimeoutMs how long one attempt may take to connect
     * @param readTimeoutMs    how long one attempt may wait for the answer
     * @param retryDelayMs     pause between attempts
     */
    static int await(String checkUrl, long totalMs, int connectTimeoutMs, int readTimeoutMs,
                     long retryDelayMs, Cancel cancel) {
        final long end = System.currentTimeMillis() + totalMs;
        while (true) {
            if (cancel.isCancelled()) return CANCELLED;
            int r = tryOnce(checkUrl, connectTimeoutMs, readTimeoutMs);
            if (r == READY || r == OFFLINE || r == UNSURE) return r;
            // r == TIMED_OUT here means "not awake yet": ask again after a short pause
            long resume = System.currentTimeMillis() + retryDelayMs;
            if (resume >= end) return TIMED_OUT;
            while (System.currentTimeMillis() < resume) {
                if (cancel.isCancelled()) return CANCELLED;
                try {
                    Thread.sleep(50);
                } catch (InterruptedException e) {
                    return CANCELLED;
                }
            }
        }
    }

    private static int tryOnce(String checkUrl, int connectTimeoutMs, int readTimeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(checkUrl).openConnection();
            c.setConnectTimeout(connectTimeoutMs);
            c.setReadTimeout(readTimeoutMs);
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            c.setRequestProperty("User-Agent", "HinduEsportsApp");
            if (c.getResponseCode() != 200) return TIMED_OUT; // sleeping hosts answer 502/503 while waking up
            InputStream in = c.getInputStream();
            byte[] buf = new byte[4096];
            int n = 0;
            while (n < buf.length) {
                int got = in.read(buf, n, buf.length - n);
                if (got < 0) break;
                n += got;
            }
            in.close();
            // the host's own "waking up" page is not our page
            return new String(buf, 0, n, "UTF-8").contains("short_name") ? READY : TIMED_OUT;
        } catch (UnknownHostException e) {
            return OFFLINE;
        } catch (ConnectException e) {
            return OFFLINE;
        } catch (NoRouteToHostException e) {
            return OFFLINE;
        } catch (SocketTimeoutException e) {
            return TIMED_OUT;
        } catch (SSLException e) {
            return UNSURE;
        } catch (IOException e) {
            return TIMED_OUT; // for example "connection reset" while the host is starting
        } catch (RuntimeException e) {
            return UNSURE;
        } finally {
            if (c != null) {
                try {
                    c.disconnect();
                } catch (RuntimeException e) {
                    // ignore
                }
            }
        }
    }
}
