package com.hinduesports.clan;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Parcel;
import android.os.RemoteException;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * HINDU ESPORTS launcher.
 *
 * The app is the website itself. This screen opens https://hindu-esports.onrender.com in Chrome as a
 * "Trusted Web Activity": full screen, no address bar, with the web push alerts, camera, microphone and
 * Google sign-in that the site already uses.  The protocol below is the one Google's own
 * android-browser-helper / androidx.browser libraries speak (Custom Tabs service -> new session ->
 * ACTION_VIEW intent carrying the session and LAUNCH_AS_TRUSTED_WEB_ACTIVITY).  It is written out by hand
 * so the whole app is a single small file with no libraries.
 *
 * The page is shown without browser bars only if the site vouches for this app through
 * https://hindu-esports.onrender.com/.well-known/assetlinks.json (package name + signing key).  If that
 * check, or Chrome itself, is not available, the site still opens (with a small bar, or in the browser).
 *
 * The site is on free hosting, which puts the server to sleep after a while; the first open after that can
 * take up to about a minute to wake up. Rather than hand that wait to Chrome (which could show the host's own
 * "waking up" or error page before the site is ready), this screen quietly asks the server for a small file of
 * its own first ({@link ServerWake}) and only opens Chrome once the real site answers — so the clan's own black
 * screen with its logo is all that is ever shown while waiting, never anything from the hosting company.
 */
public class LauncherActivity extends Activity {
    private static final String TAG = "HinduEsports";

    /** The only site this app opens. */
    private static final String START_URL = "https://hindu-esports.onrender.com/";
    private static final String SITE_HOST = "hindu-esports.onrender.com";
    private static final int BAR_COLOR = 0xFF000000; // status + navigation bar: black, like the app

    // ---- Custom Tabs / Trusted Web Activity protocol (same names Google's libraries use) ----
    private static final String ACTION_CUSTOM_TABS_CONNECTION =
            "android.support.customtabs.action.CustomTabsService";
    private static final String CATEGORY_TRUSTED_WEB_ACTIVITY =
            "androidx.browser.trusted.category.TrustedWebActivities";
    private static final String DESCRIPTOR_SERVICE = "android.support.customtabs.ICustomTabsService";
    private static final String DESCRIPTOR_CALLBACK = "android.support.customtabs.ICustomTabsCallback";
    // The .aidl files number their methods (ICustomTabsService: warmup = 1, newSession = 2;
    // ICustomTabsCallback: extraCallbackWithResult = 6).  On the wire every call is sent with the
    // code IBinder.FIRST_CALL_TRANSACTION (= 1) + that number, which is what the AIDL compiler
    // writes into the generated TRANSACTION_* constants on both sides.
    private static final int TX_WARMUP = IBinder.FIRST_CALL_TRANSACTION + 1;       // boolean warmup(long)
    private static final int TX_NEW_SESSION = IBinder.FIRST_CALL_TRANSACTION + 2;  // boolean newSession(cb)
    private static final int TX_CALLBACK_EXTRA_WITH_RESULT = IBinder.FIRST_CALL_TRANSACTION + 6;
    private static final String EXTRA_SESSION = "android.support.customtabs.extra.SESSION";
    private static final String EXTRA_LAUNCH_AS_TWA =
            "android.support.customtabs.extra.LAUNCH_AS_TRUSTED_WEB_ACTIVITY";
    private static final String EXTRA_TOOLBAR_COLOR = "android.support.customtabs.extra.TOOLBAR_COLOR";
    private static final String EXTRA_NAVIGATION_BAR_COLOR =
            "androidx.browser.customtabs.extra.NAVIGATION_BAR_COLOR";
    private static final String EXTRA_ENABLE_INSTANT_APPS =
            "android.support.customtabs.extra.EXTRA_ENABLE_INSTANT_APPS";
    private static final String EXTRA_SHARE_STATE = "androidx.browser.customtabs.extra.SHARE_STATE";

    private static final String KEY_LAUNCHED = "hindu.esports.launched";
    private static final long CONNECT_TIMEOUT_MS = 10000; // slow phones need a few seconds to wake Chrome up

    // Free hosting: the server sleeps when nobody has used it for a while, and the first request after that
    // can take up to about a minute to wake it. We wait for it ourselves (on our own black screen) rather
    // than let Chrome show whatever the host displays while it is starting up.
    private static final String WAKE_CHECK_URL = START_URL + "manifest.webmanifest";
    private static final long WAKE_TOTAL_MS = 55000;
    private static final int WAKE_CONNECT_MS = 6000;
    private static final int WAKE_READ_MS = 6000;
    private static final long WAKE_RETRY_MS = 1200;
    private static final long WAKE_SCREEN_GRACE_MS = 900; // do not flash the "waking up" text on fast opens

    private static final int MODE_TRUSTED_WEB_ACTIVITY = 0;
    private static final int MODE_CUSTOM_TAB = 1;
    private static final int MODE_BROWSER = 2;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Uri url = Uri.parse(START_URL);
    private int mode = MODE_BROWSER;
    private String provider;
    private boolean bound;
    private boolean launched;
    private boolean cancelled;
    private SessionCallback callback;
    private TextView waitText;

    // ------------------------------------------------------------------------------------------
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null && savedInstanceState.getBoolean(KEY_LAUNCHED)) {
            finish(); // the site was already opened; do not open it twice
            return;
        }
        try {
            url = chooseUrl(getIntent());
            startWaking();
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not start the app view", e);
            openFallback();
        }
    }

    // ---- waiting for the site to wake up, on our own screen -----------------------------------------
    private void startWaking() {
        final Handler bg = new Handler(Looper.getMainLooper()); // posts back from the waiting thread below
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!launched && !cancelled) showWaitScreen();
            }
        }, WAKE_SCREEN_GRACE_MS);

        new Thread(new Runnable() {
            @Override
            public void run() {
                final int result;
                try {
                    result = ServerWake.await(WAKE_CHECK_URL, WAKE_TOTAL_MS, WAKE_CONNECT_MS, WAKE_READ_MS,
                            WAKE_RETRY_MS, new ServerWake.Cancel() {
                                @Override
                                public boolean isCancelled() {
                                    return cancelled || isFinishing();
                                }
                            });
                } catch (RuntimeException e) {
                    bg.post(new Runnable() {
                        @Override
                        public void run() {
                            onWakeDone(ServerWake.UNSURE);
                        }
                    });
                    return;
                }
                bg.post(new Runnable() {
                    @Override
                    public void run() {
                        onWakeDone(result);
                    }
                });
            }
        }, "hindu-esports-wake").start();
    }

    private void onWakeDone(int result) {
        if (cancelled || isFinishing()) return;
        handler.removeCallbacksAndMessages(null);
        if (result == ServerWake.OFFLINE) {
            showOfflineScreen();
            return;
        }
        // READY, TIMED_OUT (the server is probably awake by now anyway) and UNSURE: open the site.
        hideWaitScreen();
        openSite();
    }

    private void openSite() {
        try {
            pickProvider();
            if (mode == MODE_TRUSTED_WEB_ACTIVITY && provider != null && connect()) {
                handler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (!launched) {
                            Log.w(TAG, "Browser did not answer in time; opening the site the simple way");
                            openFallback();
                        }
                    }
                }, CONNECT_TIMEOUT_MS);
                return;
            }
            openFallback();
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not start the app view", e);
            openFallback();
        }
    }

    /** A small status line under the logo that is already on screen (the theme's black splash). */
    private void showWaitScreen() {
        if (waitText != null) return;
        FrameLayout root = new FrameLayout(this);
        TextView t = new TextView(this);
        t.setText("Waking up the clan server…\nFree hosting — this can take up to a minute");
        t.setTextColor(0xFFFFD9BF);
        t.setGravity(Gravity.CENTER);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        t.setLineSpacing(4, 1f);
        FrameLayout.LayoutParams tp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.gravity = Gravity.CENTER_HORIZONTAL | Gravity.BOTTOM;
        tp.bottomMargin = dp(96);
        tp.leftMargin = dp(32);
        tp.rightMargin = dp(32);
        root.addView(t, tp);

        ProgressBar spinner = new ProgressBar(this);
        FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(dp(28), dp(28));
        sp.gravity = Gravity.CENTER_HORIZONTAL | Gravity.BOTTOM;
        sp.bottomMargin = dp(64);
        root.addView(spinner, sp);

        setContentView(root);
        waitText = t;
    }

    private void hideWaitScreen() {
        waitText = null;
    }

    /** No network at all: do not hand this to Chrome (it would show its own offline page). Let the person retry. */
    private void showOfflineScreen() {
        FrameLayout root = new FrameLayout(this);
        TextView t = new TextView(this);
        t.setText("No internet connection.\nTap anywhere to try again.");
        t.setTextColor(0xFFFFD9BF);
        t.setGravity(Gravity.CENTER);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        t.setLineSpacing(4, 1f);
        FrameLayout.LayoutParams tp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.gravity = Gravity.CENTER;
        tp.leftMargin = dp(32);
        tp.rightMargin = dp(32);
        root.addView(t, tp);
        root.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                waitText = null;
                startWaking();
            }
        });
        setContentView(root);
        waitText = t;
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putBoolean(KEY_LAUNCHED, launched);
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        if (launched) finish(); // the user closed the site and came back here
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        cancelled = true;
        handler.removeCallbacksAndMessages(null);
        disconnect();
    }

    // ------------------------------------------------------------------------------------------
    /** Only ever open this app's own website; an invitation link keeps its path. */
    private static Uri chooseUrl(Intent intent) {
        Uri start = Uri.parse(START_URL);
        Uri data = intent == null ? null : intent.getData();
        if (data != null
                && "https".equalsIgnoreCase(data.getScheme())
                && SITE_HOST.equalsIgnoreCase(data.getHost())
                && data.getUserInfo() == null
                && (data.getPort() == -1 || data.getPort() == 443)) {
            return Uri.parse(data.toString());
        }
        return start;
    }

    // ---- picking the browser (same decision as Google's TwaProviderPicker) --------------------
    private void pickProvider() {
        PackageManager pm = getPackageManager();
        Intent query = new Intent(Intent.ACTION_VIEW)
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .setData(Uri.fromParts("http", "", null));

        String bestCct = null;
        boolean bestCctPrivileged = false;
        String bestBrowser = null;
        boolean bestBrowserPrivileged = false;

        List<ResolveInfo> candidates =
                new ArrayList<ResolveInfo>(pm.queryIntentActivities(query, PackageManager.MATCH_DEFAULT_ONLY));
        boolean headIsAuthoritative = candidates.size() == 1;
        if (Build.VERSION.SDK_INT >= 23) {
            candidates.addAll(pm.queryIntentActivities(query, PackageManager.MATCH_ALL));
        }
        Map<String, Integer> services = launchModesForCustomTabsServices(pm);

        for (int i = 0; i < candidates.size(); i++) {
            String name = candidates.get(i).activityInfo.packageName;
            Integer found = services.get(name);
            int launchMode = found == null ? MODE_BROWSER : found.intValue();
            switch (launchMode) {
                case MODE_TRUSTED_WEB_ACTIVITY:
                    if ((i == 0 && headIsAuthoritative) || isSystemOrStoreInstalled(pm, name)) {
                        mode = MODE_TRUSTED_WEB_ACTIVITY;
                        provider = name;
                        return;
                    } else if (bestCct == null) {
                        bestCct = name;
                        bestCctPrivileged = false;
                    }
                    break;
                case MODE_CUSTOM_TAB:
                    if (i == 0 && headIsAuthoritative) {
                        bestCct = name;
                        bestCctPrivileged = true;
                    } else if (bestCct == null) {
                        bestCct = name;
                        bestCctPrivileged = isSystemOrStoreInstalled(pm, name);
                    } else if (!bestCctPrivileged && isSystemOrStoreInstalled(pm, name)) {
                        bestCct = name;
                        bestCctPrivileged = true;
                    }
                    break;
                default:
                    if (i == 0 && headIsAuthoritative) {
                        bestBrowser = name;
                        bestBrowserPrivileged = true;
                    } else if (bestBrowser == null) {
                        bestBrowser = name;
                        bestBrowserPrivileged = isSystemOrStoreInstalled(pm, name);
                    } else if (!bestBrowserPrivileged && isSystemOrStoreInstalled(pm, name)) {
                        bestBrowser = name;
                        bestBrowserPrivileged = true;
                    }
                    break;
            }
        }
        if (bestCct != null) {
            mode = MODE_CUSTOM_TAB;
            provider = bestCct;
        } else {
            mode = MODE_BROWSER;
            provider = bestBrowser;
        }
    }

    private static Map<String, Integer> launchModesForCustomTabsServices(PackageManager pm) {
        List<ResolveInfo> services = pm.queryIntentServices(
                new Intent(ACTION_CUSTOM_TABS_CONNECTION), PackageManager.GET_RESOLVED_FILTER);
        Map<String, Integer> out = new HashMap<String, Integer>();
        for (ResolveInfo service : services) {
            String name = service.serviceInfo.packageName;
            if (chromeSupportsTrustedWebActivities(pm, name)) {
                out.put(name, Integer.valueOf(MODE_TRUSTED_WEB_ACTIVITY));
                continue;
            }
            boolean supportsTwa = service.filter != null
                    && service.filter.hasCategory(CATEGORY_TRUSTED_WEB_ACTIVITY);
            out.put(name, Integer.valueOf(supportsTwa ? MODE_TRUSTED_WEB_ACTIVITY : MODE_CUSTOM_TAB));
        }
        return out;
    }

    private static boolean isSystemOrStoreInstalled(PackageManager pm, String packageName) {
        try {
            ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
            if (info != null && (info.flags
                    & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0) {
                return true;
            }
        } catch (PackageManager.NameNotFoundException e) {
            // fall through
        } catch (RuntimeException e) {
            // fall through
        }
        try {
            return "com.android.vending".equals(pm.getInstallerPackageName(packageName));
        } catch (RuntimeException e) {
            return false;
        }
    }

    // ---- very old Chrome builds (before the TWA category existed) ------------------------------
    private static final List<String> CHROME_PACKAGES = Arrays.asList(
            "com.google.android.apps.chrome", "org.chromium.chrome", "com.chrome.canary",
            "com.chrome.dev", "com.chrome.beta", "com.android.chrome");
    private static final List<String> CHROME_LOCAL_BUILDS =
            Arrays.asList("com.google.android.apps.chrome", "org.chromium.chrome");
    private static final int CHROME_VERSION_TWA = 362600000;
    private static final int CHROME_VERSION_NO_WARMUP = 368300000;

    private static boolean chromeSupportsTrustedWebActivities(PackageManager pm, String name) {
        return CHROME_PACKAGES.contains(name) && chromeVersionAtLeast(pm, name, CHROME_VERSION_TWA);
    }

    private static boolean supportsLaunchWithoutWarmup(PackageManager pm, String name) {
        if (!CHROME_PACKAGES.contains(name)) return true;
        return chromeVersionAtLeast(pm, name, CHROME_VERSION_NO_WARMUP);
    }

    private static boolean chromeVersionAtLeast(PackageManager pm, String name, int version) {
        if (CHROME_LOCAL_BUILDS.contains(name)) return true;
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                return (int) pm.getPackageInfo(name, 0).getLongVersionCode() >= version;
            }
            return pm.getPackageInfo(name, 0).versionCode >= version;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        } catch (RuntimeException e) {
            return false;
        }
    }

    // ---- talking to the browser -------------------------------------------------------------------
    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            if (launched || isFinishing()) return;
            try {
                if (!supportsLaunchWithoutWarmup(getPackageManager(), provider)) {
                    warmup(service);
                }
                callback = new SessionCallback();
                if (newSession(service, callback)) {
                    launchTrustedWebActivity();
                    return;
                }
                Log.w(TAG, "Browser refused to create a session");
            } catch (RemoteException e) {
                Log.w(TAG, "Browser connection failed", e);
            } catch (RuntimeException e) {
                Log.w(TAG, "Browser connection failed", e);
            }
            openFallback();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            // Nothing to do: once the site is open it no longer needs this connection.
        }
    };

    private boolean connect() {
        try {
            Intent bind = new Intent(ACTION_CUSTOM_TABS_CONNECTION).setPackage(provider);
            bound = bindService(bind, connection, BIND_AUTO_CREATE);
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not bind to the browser", e);
            bound = false;
        }
        return bound;
    }

    private void disconnect() {
        if (!bound) return;
        bound = false;
        try {
            unbindService(connection);
        } catch (RuntimeException e) {
            // already gone
        }
    }

    private static void warmup(IBinder service) throws RemoteException {
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(DESCRIPTOR_SERVICE);
            data.writeLong(0L);
            service.transact(TX_WARMUP, data, reply, 0);
            reply.readException();
        } finally {
            reply.recycle();
            data.recycle();
        }
    }

    private static boolean newSession(IBinder service, IBinder sessionCallback) throws RemoteException {
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(DESCRIPTOR_SERVICE);
            data.writeStrongBinder(sessionCallback);
            service.transact(TX_NEW_SESSION, data, reply, 0);
            reply.readException();
            return reply.readInt() != 0;
        } finally {
            reply.recycle();
            data.recycle();
        }
    }

    /** The browser calls this back with progress events. We do not need them, so just say "ok". */
    private static final class SessionCallback extends Binder {
        SessionCallback() {
            attachInterface(null, DESCRIPTOR_CALLBACK);
        }

        @Override
        protected boolean onTransact(int code, Parcel data, Parcel reply, int flags)
                throws RemoteException {
            if (code >= IBinder.FIRST_CALL_TRANSACTION && code <= IBinder.LAST_CALL_TRANSACTION) {
                if (reply != null && (flags & IBinder.FLAG_ONEWAY) == 0) {
                    reply.writeNoException();
                    if (code == TX_CALLBACK_EXTRA_WITH_RESULT) reply.writeInt(0); // null Bundle
                }
                return true;
            }
            return super.onTransact(code, data, reply, flags);
        }
    }

    // ---- opening the site ----------------------------------------------------------------------------
    private void launchTrustedWebActivity() {
        Intent intent = new Intent(Intent.ACTION_VIEW, url);
        intent.setPackage(provider);
        Bundle session = new Bundle();
        session.putBinder(EXTRA_SESSION, callback);
        intent.putExtras(session);
        intent.putExtra(EXTRA_ENABLE_INSTANT_APPS, false);
        intent.putExtra(EXTRA_TOOLBAR_COLOR, BAR_COLOR);
        intent.putExtra(EXTRA_NAVIGATION_BAR_COLOR, BAR_COLOR);
        intent.putExtra(EXTRA_SHARE_STATE, 0);
        intent.putExtra(EXTRA_LAUNCH_AS_TWA, true);
        try {
            startActivity(intent);
            launched = true;
            finish();
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not open the site as an app", e);
            openFallback();
        }
    }

    /** Last resort: a Custom Tab (small bar) if the browser supports it, otherwise any browser. */
    private void openFallback() {
        if (launched || isFinishing()) return;
        if (provider != null) {
            try {
                Intent tab = new Intent(Intent.ACTION_VIEW, url).setPackage(provider);
                Bundle noSession = new Bundle();
                noSession.putBinder(EXTRA_SESSION, null);
                tab.putExtras(noSession);
                tab.putExtra(EXTRA_TOOLBAR_COLOR, BAR_COLOR);
                startActivity(tab);
                launched = true;
                finish();
                return;
            } catch (RuntimeException e) {
                Log.w(TAG, "Custom Tab fallback failed", e);
            }
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
            launched = true;
        } catch (RuntimeException e) {
            Log.w(TAG, "No browser found", e);
            Toast.makeText(this, "Please install or enable Google Chrome to open Hindu Esports.",
                    Toast.LENGTH_LONG).show();
        }
        finish();
    }
}
