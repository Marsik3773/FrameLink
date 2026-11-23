package app.framelink.camera;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.math.BigInteger;
import java.net.Socket;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.X509ExtendedKeyManager;
import javax.security.auth.x500.X500Principal;

final class ServerIdentity {
    private static final String ALIAS = "framelink-lan-ec";
    final SSLContext context;

    ServerIdentity() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                // Conscrypt passes the already hashed TLS transcript to ECDSA.
                .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
                .setCertificateSubject(new X500Principal("CN=FrameLink"))
                .setCertificateSerialNumber(BigInteger.ONE)
                .build());
            generator.generateKeyPair();
        }
        PrivateKey key = (PrivateKey) store.getKey(ALIAS, null);
        X509Certificate certificate = (X509Certificate) store.getCertificate(ALIAS);
        SecureRandom random = new SecureRandom();
        context = SSLContext.getInstance("TLS");
        context.init(new KeyManager[] { new X509ExtendedKeyManager() {
            @Override public String[] getClientAliases(String type, Principal[] issuers) { return null; }
            @Override public String chooseClientAlias(String[] types, Principal[] issuers, Socket socket) { return null; }
            @Override public String[] getServerAliases(String type, Principal[] issuers) {
                return isEc(type) ? new String[] { ALIAS } : null;
            }
            @Override public String chooseServerAlias(String type, Principal[] issuers, Socket socket) {
                return isEc(type) ? ALIAS : null;
            }
            @Override public String chooseEngineServerAlias(String type, Principal[] issuers, SSLEngine engine) {
                return isEc(type) ? ALIAS : null;
            }
            @Override public X509Certificate[] getCertificateChain(String alias) {
                return ALIAS.equals(alias) ? new X509Certificate[] { certificate } : null;
            }
            @Override public PrivateKey getPrivateKey(String alias) {
                return ALIAS.equals(alias) ? key : null;
            }
        } }, null, random);
    }

    private static boolean isEc(String type) {
        return "EC".equals(type) || "ECDSA".equals(type);
    }

}
