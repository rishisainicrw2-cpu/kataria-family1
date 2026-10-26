import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;
import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Collections;
import java.util.List;

/** sign <in.apk> <out.apk> <keystore.p12> <alias> <password> <minSdk>   |   verify <apk> */
public class SignApk {
    public static void main(String[] a) throws Exception {
        if (a[0].equals("sign")) {
            KeyStore ks = KeyStore.getInstance("PKCS12");
            try (FileInputStream in = new FileInputStream(a[3])) { ks.load(in, a[5].toCharArray()); }
            PrivateKey key = (PrivateKey) ks.getKey(a[4], a[5].toCharArray());
            X509Certificate cert = (X509Certificate) ks.getCertificate(a[4]);
            ApkSigner.SignerConfig cfg = new ApkSigner.SignerConfig.Builder("clan", key, Collections.singletonList(cert)).build();
            new ApkSigner.Builder(Collections.singletonList(cfg))
                .setInputApk(new File(a[1])).setOutputApk(new File(a[2]))
                .setMinSdkVersion(Integer.parseInt(a[6]))
                .setV1SigningEnabled(true).setV2SigningEnabled(true).setV3SigningEnabled(true)
                .build().sign();
            System.out.println("signed " + a[2]);
        } else {
            ApkVerifier.Result r = new ApkVerifier.Builder(new File(a[1])).build().verify();
            System.out.println("verified=" + r.isVerified() + " v1=" + r.isVerifiedUsingV1Scheme() + " v2=" + r.isVerifiedUsingV2Scheme() + " v3=" + r.isVerifiedUsingV3Scheme());
            for (ApkVerifier.IssueWithParams e : r.getErrors()) System.out.println("ERROR " + e);
            for (ApkVerifier.IssueWithParams e : r.getWarnings()) System.out.println("warn  " + e);
            List<X509Certificate> certs = r.getSignerCertificates();
            for (X509Certificate c : certs) {
                byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(c.getEncoded());
                StringBuilder sb = new StringBuilder(); for (int i = 0; i < d.length; i++) { if (i > 0) sb.append(':'); sb.append(String.format("%02X", d[i])); }
                System.out.println("cert SHA-256 " + sb + "  " + c.getSubjectX500Principal());
            }
            System.exit(r.isVerified() ? 0 : 1);
        }
    }
}
