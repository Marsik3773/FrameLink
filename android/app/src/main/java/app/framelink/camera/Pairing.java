package app.framelink.camera;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.math.BigInteger;
import java.net.Socket;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509ExtendedKeyManager;
import javax.security.auth.x500.X500Principal;

final class Pairing {
    private static final String ALIAS = "framelink-lan";
    final SSLContext context;
    final String fingerprint;
    final String secret;

    Pairing() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA", "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setKeySize(2048)
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
                .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1, KeyProperties.SIGNATURE_PADDING_RSA_PSS)
                .setCertificateSubject(new X500Principal("CN=FrameLink"))
                .setCertificateSerialNumber(BigInteger.ONE)
                .build());
            generator.generateKeyPair();
        }
        PrivateKey key = (PrivateKey) store.getKey(ALIAS, null);
        X509Certificate certificate = (X509Certificate) store.getCertificate(ALIAS);
        SecureRandom random = new SecureRandom();
        byte[] pin = new byte[6];
        random.nextBytes(pin);
        secret = hex(pin, pin.length);
        fingerprint = hex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()), 8);

        context = SSLContext.getInstance("TLS");
        context.init(new KeyManager[] { new X509ExtendedKeyManager() {
            @Override public String[] getClientAliases(String type, Principal[] issuers) { return null; }
            @Override public String chooseClientAlias(String[] types, Principal[] issuers, Socket socket) { return null; }
            @Override public String[] getServerAliases(String type, Principal[] issuers) {
                return "RSA".equals(type) ? new String[] { ALIAS } : null;
            }
            @Override public String chooseServerAlias(String type, Principal[] issuers, Socket socket) {
                return "RSA".equals(type) ? ALIAS : null;
            }
            @Override public X509Certificate[] getCertificateChain(String alias) {
                return ALIAS.equals(alias) ? new X509Certificate[] { certificate } : null;
            }
            @Override public PrivateKey getPrivateKey(String alias) {
                return ALIAS.equals(alias) ? key : null;
            }
        } }, null, random);
    }

    String code() {
        return fingerprint.substring(0, 8) + "-" + fingerprint.substring(8) + "-"
            + secret.substring(0, 6) + "-" + secret.substring(6);
    }

    private static String hex(byte[] bytes, int count) {
        StringBuilder value = new StringBuilder();
        for (int i = 0; i < count; i++) {
            value.append(Character.forDigit((bytes[i] & 255) >> 4, 16));
            value.append(Character.forDigit(bytes[i] & 15, 16));
        }
        return value.toString();
    }
}
