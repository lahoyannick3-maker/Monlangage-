package __APPID__;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

// Lecture ZIP de GROS fichiers (liste.zip / lire.entrer.zip(chemin, nom) / extrait.entrer.zip du langage MLG).
// - Le repertoire central est lu par morceaux directement dans le fichier : jamais le zip entier en memoire.
// - Lecture par morceaux : une entree NON compressee se lit a n'importe quelle position ; une entree COMPRESSEE se lit
//   depuis son debut (le deflate est sequentiel). Le dernier flux ouvert est CONSERVE : si l'appel suivant demande
//   exactement la suite, on continue sans repartir du debut ; sinon (retour en arriere) on repart du debut.
// - Le CRC32 est verifie des que l'entree a ete lue en entier d'un seul tenant depuis son debut.
// - ZIP64 : EOCD ZIP64, tailles et positions ZIP64 des entrees.
// - Entrees CHIFFREES (modpas~) : ZipCrypto (ancien) et AES-128/192/256 (WinZip AE-1/AE-2). Le dechiffrement se fait par blocs dans le flux,
//   jamais l'entree entiere en memoire ; mot de passe verifie des l'ouverture (octet de controle / valeur de verification AES) ; l'authenticite
//   AES (HMAC-SHA1) est verifiee quand l'entree a ete lue jusqu'a sa fin. Une entree chiffree se lit comme une entree compressee (sequentiel).
// - Extraction vers un fichier : ecrite dans "destination.part" puis renommee a la fin (jamais de fichier a moitie ecrit).
// Les methodes "OK/ERR" renvoient "OK", "OK:valeur" ou "ERR:message" ; lireOctets leve une IOException dont le message
// est destine a l'utilisateur. N'utilise QUE java.io / java.util (compatible Android API 22+).
public final class MonLangageZipLecture {
    private MonLangageZipLecture() {}

    private static final int TAMPON = 64 * 1024;
    private static final long MAX_LECTURE = 64L * 1024 * 1024;     // plafond de securite d'UN appel de lecture
    private static final Charset LATIN1 = Charset.forName("ISO-8859-1");

    // ------------------------------------------------------------------ une entree du repertoire central
    static final class Info {
        String nom;
        int flags, methode, methodeEff, heure, aesForce, aesVersion;
        boolean verifCrc = true;
        long crc, csize, usize, enteteOff;
        long dataOff = -1;
        long suivant;                    // position du prochain enregistrement du repertoire central
    }

    private static long u16(byte[] b, int o) { return ((b[o] & 0xff) | ((b[o + 1] & 0xff) << 8)) & 0xFFFFL; }
    private static long u32(byte[] b, int o) { return (u16(b, o) | (u16(b, o + 2) << 16)) & 0xFFFFFFFFL; }
    private static long u64(byte[] b, int o) { return u32(b, o) | (u32(b, o + 4) << 32); }

    private static String decoderNom(byte[] n, int flags) {
        if ((flags & 0x0800) != 0) return new String(n, StandardCharsets.UTF_8);
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(n)).toString();
        } catch (CharacterCodingException e) {
            return new String(n, LATIN1);     // anciens zips : pas de drapeau UTF-8
        }
    }

    // ------------------------------------------------------------------ repertoire central
    static final class Central { long debut, taille, nb; }

    private static Central localiserCentral(RandomAccessFile f, String chemin) throws IOException {
        long len = f.length();
        if (len < 22) throw new IOException("'" + chemin + "' n'est pas un fichier zip valide (trop petit)");
        int lire = (int) Math.min(len, 65535L + 22 + 20);
        byte[] fin = new byte[lire];
        f.seek(len - lire);
        f.readFully(fin);
        int e = -1;
        for (int i = lire - 22; i >= 0; i--) {
            if (fin[i] == 0x50 && fin[i + 1] == 0x4b && fin[i + 2] == 5 && fin[i + 3] == 6) { e = i; break; }
        }
        if (e < 0) throw new IOException("'" + chemin + "' n'est pas un fichier zip valide (fin de repertoire introuvable)");
        if (u16(fin, e + 4) != 0 || u16(fin, e + 6) != 0) throw new IOException("'" + chemin + "' : archive en plusieurs parties (non geree)");
        Central c = new Central();
        c.nb = u16(fin, e + 10);
        c.taille = u32(fin, e + 12);
        c.debut = u32(fin, e + 16);
        if (c.nb == 0xFFFFL || c.taille == 0xFFFFFFFFL || c.debut == 0xFFFFFFFFL) {
            if (e >= 20 && fin[e - 20] == 0x50 && fin[e - 19] == 0x4b && fin[e - 18] == 6 && fin[e - 17] == 7) {
                long z64 = u64(fin, e - 20 + 8);
                byte[] r = new byte[56];
                if (z64 < 0 || z64 + 56 > len) throw new IOException("'" + chemin + "' : repertoire zip64 abime");
                f.seek(z64);
                f.readFully(r);
                if (u32(r, 0) != 0x06064b50L) throw new IOException("'" + chemin + "' : repertoire zip64 abime");
                c.nb = u64(r, 32);
                c.taille = u64(r, 40);
                c.debut = u64(r, 48);
            } else {
                throw new IOException("'" + chemin + "' : repertoire zip64 introuvable (archive abimee)");
            }
        }
        if (c.debut < 0 || c.taille < 0 || c.debut + c.taille > len) throw new IOException("'" + chemin + "' : repertoire central abime (archive tronquee ?)");
        return c;
    }

    // Lit l'enregistrement du repertoire central situe a "pos" ; renvoie null a la fin.
    private static Info lireEnregistrement(java.io.DataInputStream in, long pos, long finCentral, String chemin) throws IOException {
        if (pos + 46 > finCentral) return null;
        byte[] h = new byte[46];
        in.readFully(h);
        if (u32(h, 0) != 0x02014b50L) throw new IOException("'" + chemin + "' : repertoire central abime");
        Info i = new Info();
        i.flags = (int) u16(h, 8);
        i.methode = (int) u16(h, 10);
        i.heure = (int) u16(h, 12);
        i.crc = u32(h, 16);
        i.csize = u32(h, 20);
        i.usize = u32(h, 24);
        int nl = (int) u16(h, 28), el = (int) u16(h, 30), cl = (int) u16(h, 32);
        i.enteteOff = u32(h, 42);
        if (pos + 46 + nl + el + cl > finCentral) throw new IOException("'" + chemin + "' : repertoire central abime");
        byte[] n = new byte[nl];
        in.readFully(n);
        byte[] ex = new byte[el];
        in.readFully(ex);
        long saut = cl;
        while (saut > 0) { long s = in.skip(saut); if (s <= 0) throw new IOException("'" + chemin + "' : repertoire central tronque"); saut -= s; }
        // extra ZIP64 : champs presents dans l'ordre (taille reelle, taille compressee, position) seulement si la valeur 32 bits vaut 0xFFFFFFFF
        boolean bu = i.usize == 0xFFFFFFFFL, bc = i.csize == 0xFFFFFFFFL, bo = i.enteteOff == 0xFFFFFFFFL;
        if (bu || bc || bo) {
            int o = 0;
            while (o + 4 <= ex.length) {
                int id = (int) u16(ex, o), tl = (int) u16(ex, o + 2);
                if (id == 1) {
                    int p = o + 4;
                    if (bu && p + 8 <= o + 4 + tl) { i.usize = u64(ex, p); p += 8; }
                    if (bc && p + 8 <= o + 4 + tl) { i.csize = u64(ex, p); p += 8; }
                    if (bo && p + 8 <= o + 4 + tl) { i.enteteOff = u64(ex, p); }
                    break;
                }
                o += 4 + tl;
            }
        }
        i.methodeEff = i.methode;
        if (i.methode == 99) {                       // chiffrement AES WinZip : extra 0x9901 (version, "AE", force, vraie methode)
            int o = 0;
            while (o + 4 <= ex.length) {
                int id = (int) u16(ex, o), tl = (int) u16(ex, o + 2);
                if (id == 0x9901 && tl >= 7 && o + 4 + 7 <= ex.length) {
                    i.aesVersion = (int) u16(ex, o + 4);
                    i.aesForce = ex[o + 8] & 0xff;
                    i.methodeEff = (int) u16(ex, o + 9);
                    i.verifCrc = i.aesVersion != 2;   // AE-2 : pas de CRC (l'authenticite est garantie par le HMAC)
                    if (i.aesForce < 1 || i.aesForce > 3) i.aesForce = 0;
                    break;
                }
                o += 4 + tl;
            }
        }
        i.nom = decoderNom(n, i.flags);
        i.suivant = pos + 46 + nl + el + cl;
        return i;
    }

    private static java.io.DataInputStream ouvrirFlux(File fichier, long pos) throws IOException {
        FileInputStream fis = new FileInputStream(fichier);
        fis.getChannel().position(pos);
        return new java.io.DataInputStream(new BufferedInputStream(fis, TAMPON));
    }

    // Cherche une entree par son nom. Un nom en double : la DERNIERE occurrence l'emporte (comme Python zipfile).
    private static Info chercher(File fichier, String nom) throws IOException {
        if (nom == null || nom.isEmpty() || nom.endsWith("/")) return null;
        Info trouve = null;
        try (RandomAccessFile f = new RandomAccessFile(fichier, "r")) {
            Central c = localiserCentral(f, fichier.getPath());
            long fin = c.debut + c.taille, pos = c.debut;
            try (java.io.DataInputStream in = ouvrirFlux(fichier, pos)) {
                while (true) {
                    Info i = lireEnregistrement(in, pos, fin, fichier.getPath());
                    if (i == null) break;
                    pos = i.suivant;
                    if (i.nom.equals(nom)) trouve = i;
                }
            }
        }
        return trouve;
    }

    private static String echapper(String s) {
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            if (c == '"' || c == '\\') { b.append('\\').append(c); }
            else if (c < 0x20) { b.append(String.format("\\u%04x", (int) c)); }
            else b.append(c);
        }
        return b.toString();
    }

    // ------------------------------------------------------------------ liste.zip : par pages (offset -1 = premiere page)
    // Renvoie {"s":<position suivante ou -1>,"f":<fin du repertoire>,"e":[["nom",taille],...]} (dossiers ignores).
    public static synchronized String liste(String chemin, double offset, double fin, int max) {
        try {
            File fichier = new File(chemin == null ? "" : chemin);
            if (!fichier.isFile()) return "ERR:fichier zip introuvable : '" + chemin + "'";
            if (max <= 0) max = 5000;
            long pos, finC;
            if (offset < 0) {
                try (RandomAccessFile f = new RandomAccessFile(fichier, "r")) {
                    Central c = localiserCentral(f, chemin);
                    pos = c.debut;
                    finC = c.debut + c.taille;
                }
            } else { pos = (long) offset; finC = (long) fin; }
            StringBuilder b = new StringBuilder("{\"e\":[");
            int n = 0;
            long suivant = -1;
            try (java.io.DataInputStream in = ouvrirFlux(fichier, pos)) {
                while (n < max) {
                    Info i = lireEnregistrement(in, pos, finC, chemin);
                    if (i == null) { pos = -1; break; }
                    pos = i.suivant;
                    if (i.nom.endsWith("/")) continue;
                    if (n > 0) b.append(',');
                    b.append("[\"").append(echapper(i.nom)).append("\",").append(i.usize).append(']');
                    n++;
                }
                suivant = (pos < 0 || pos >= finC) ? -1 : pos;
            }
            b.append("],\"s\":").append(suivant).append(",\"f\":").append(finC).append('}');
            return "OK:" + b;
        } catch (IOException | RuntimeException e) {
            return "ERR:" + e.getMessage();
        }
    }

    // ------------------------------------------------------------------ dechiffrement (ZipCrypto et AES)
    static abstract class Dechiffre {
        abstract void traiter(byte[] b, int off, int len);                       // dechiffre sur place
        void fin(RandomAccessFile raf, String nom) throws IOException {}         // controle final (AES : HMAC)
    }

    private static final int[] CRCT = new int[256];
    static {
        for (int n = 0; n < 256; n++) { int c = n; for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; CRCT[n] = c; }
    }

    static final class ZipCryptoDech extends Dechiffre {
        int k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
        ZipCryptoDech(byte[] mdp) { for (byte b : mdp) maj(b & 0xff); }
        void maj(int c) {
            k0 = (k0 >>> 8) ^ CRCT[(k0 ^ c) & 0xff];
            k1 = (k1 + (k0 & 0xff)) * 134775813 + 1;
            k2 = (k2 >>> 8) ^ CRCT[(k2 ^ (k1 >>> 24)) & 0xff];
        }
        void traiter(byte[] b, int off, int len) {
            for (int i = off; i < off + len; i++) {
                int t = (k2 | 2) & 0xffff;
                int c = (b[i] & 0xff) ^ (((t * (t ^ 1)) >>> 8) & 0xff);
                maj(c);
                b[i] = (byte) c;
            }
        }
    }

    static final class AesDech extends Dechiffre {
        final Cipher aes; final Mac mac; final byte[] ctr = new byte[16], ks = new byte[16]; int ksPos = 16;
        AesDech(byte[] cleAes, byte[] cleMac) throws GeneralSecurityException {
            aes = Cipher.getInstance("AES/ECB/NoPadding");
            aes.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(cleAes, "AES"));
            mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(cleMac, "HmacSHA1"));
        }
        void traiter(byte[] b, int off, int len) {
            mac.update(b, off, len);                     // le HMAC porte sur les donnees CHIFFREES
            try {
                for (int i = off; i < off + len; i++) {
                    if (ksPos == 16) {
                        for (int j = 0; j < 16; j++) { if (++ctr[j] != 0) break; }   // compteur little-endian, commence a 1
                        aes.update(ctr, 0, 16, ks, 0);
                        ksPos = 0;
                    }
                    b[i] ^= ks[ksPos++];
                }
            } catch (GeneralSecurityException e) { throw new IllegalStateException(e.getMessage()); }
        }
        // ECRITURE (zip chiffre) : chiffre sur place puis fait entrer le texte CHIFFRE dans le HMAC ; marque() = 10 premiers octets du HMAC.
        void chiffrer(byte[] b, int off, int len) {
            try {
                for (int i = off; i < off + len; i++) {
                    if (ksPos == 16) {
                        for (int j = 0; j < 16; j++) { if (++ctr[j] != 0) break; }
                        aes.update(ctr, 0, 16, ks, 0);
                        ksPos = 0;
                    }
                    b[i] ^= ks[ksPos++];
                }
            } catch (GeneralSecurityException e) { throw new IllegalStateException(e.getMessage()); }
            mac.update(b, off, len);
        }
        byte[] marque() { return java.util.Arrays.copyOf(mac.doFinal(), 10); }
        void fin(RandomAccessFile raf, String nom) throws IOException {
            byte[] tag = new byte[10];
            raf.readFully(tag);
            byte[] calc = mac.doFinal();
            for (int i = 0; i < 10; i++) {
                if (tag[i] != calc[i]) throw new IOException("'" + nom + "' est abime ou modifie (le controle d'authenticite AES ne correspond pas)");
            }
        }
    }

    // PBKDF2-HMAC-SHA1 ecrit ici (octets du mot de passe en UTF-8) : ne depend pas de la variante d'encodage de PBEKeySpec selon les versions d'Android.
    static byte[] pbkdf2(byte[] mdp, byte[] sel, int iterations, int longueur) throws GeneralSecurityException {
        Mac m = Mac.getInstance("HmacSHA1");
        m.init(new SecretKeySpec(mdp, "HmacSHA1"));
        byte[] sortie = new byte[longueur];
        int blocs = (longueur + 19) / 20;
        for (int b = 1; b <= blocs; b++) {
            m.update(sel);
            m.update(new byte[] { (byte) (b >>> 24), (byte) (b >>> 16), (byte) (b >>> 8), (byte) b });
            byte[] u = m.doFinal();
            byte[] t = u.clone();
            for (int it = 1; it < iterations; it++) {
                u = m.doFinal(u);
                for (int k = 0; k < t.length; k++) t[k] ^= u[k];
            }
            System.arraycopy(t, 0, sortie, (b - 1) * 20, Math.min(20, longueur - (b - 1) * 20));
        }
        return sortie;
    }

    // ------------------------------------------------------------------ Deflate64 (methode 9) : decodeur ecrit ici
    // java.util.zip.Inflater ne sait pas lire le Deflate64 (fenetre de 64 Ko). Differences avec le deflate normal :
    // fenetre de 65536 octets ; le code de longueur 285 vaut base 3 + 16 bits supplementaires (jusqu'a 65538) au lieu de 258 ;
    // les codes de distance 30 et 31 existent (14 bits supplementaires, bases 32769 et 49153). Tout le reste est identique.
    // Decodeur "a la demande" : produit exactement ce qu'on lui demande, garde son etat entre deux appels (position dans
    // un bloc, copie en cours) et ne garde que la fenetre de 64 Ko et un tampon d'entree : jamais l'entree entiere en memoire.
    static final class Inflate64 {
        interface Source { int lire(byte[] b, int off, int len) throws IOException; }   // -1 : plus de donnees

        private static final int[] LB = { 3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,3 };
        private static final int[] LE = { 0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,16 };
        private static final int[] DB = { 1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,32769,49153 };
        private static final int[] DE = { 0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,14,14 };
        private static final int[] ORDRE = { 16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15 };
        private static final int RAPIDE = 10;

        // Code de Huffman canonique : table rapide (RAPIDE bits) + decodage bit a bit pour les codes plus longs.
        static final class Huff {
            final short[] compte = new short[16];
            short[] symbole;
            final short[] rapide = new short[1 << RAPIDE];     // (symbole << 4) | longueur ; 0 = absent
            // retourne : <0 sur-souscrit ; 0 complet ; >0 incomplet
            int construire(int[] lg, int off, int n) {
                java.util.Arrays.fill(compte, (short) 0);
                java.util.Arrays.fill(rapide, (short) 0);
                symbole = new short[n];
                for (int i = 0; i < n; i++) compte[lg[off + i]]++;
                if (compte[0] == n) return 0;
                int gauche = 1;
                for (int l = 1; l <= 15; l++) { gauche <<= 1; gauche -= compte[l]; if (gauche < 0) return gauche; }
                int[] decal = new int[16];
                for (int l = 1; l < 15; l++) decal[l + 1] = decal[l] + compte[l];
                for (int i = 0; i < n; i++) if (lg[off + i] != 0) symbole[decal[lg[off + i]]++] = (short) i;
                // table rapide : codes canoniques de longueur <= RAPIDE, bits inverses (le flux est lu poids faible d'abord)
                int code = 0, idx = 0;
                for (int l = 1; l <= RAPIDE; l++) {
                    for (int k = 0; k < compte[l]; k++, idx++, code++) {
                        int inv = 0;
                        for (int b = 0; b < l; b++) if ((code & (1 << b)) != 0) inv |= 1 << (l - 1 - b);
                        short e = (short) ((symbole[idx] << 4) | l);
                        for (int p = inv; p < (1 << RAPIDE); p += 1 << l) rapide[p] = e;
                    }
                    code <<= 1;
                }
                return gauche;
            }
        }

        private final Source src;
        private final byte[] ent = new byte[32768];
        private int entPos = 0, entLen = 0;
        private long tampon = 0;
        private int nbits = 0;
        private final byte[] fen = new byte[65536];
        private int fenPos = 0;
        private long sortie = 0;
        private static final int ENTETE = 0, STOCKE = 1, HUFFMAN = 2, FIN = 3;
        private int etat = ENTETE;
        private boolean dernier;
        private int stockeRestant;
        private int copieLong, copieDist;
        private final Huff lit = new Huff(), dist = new Huff();

        Inflate64(Source src) { this.src = src; }

        boolean fini() { return etat == FIN && copieLong == 0; }

        private IOException abime(String m) { return new IOException("donnees Deflate64 abimees : " + m); }

        private boolean remplirOctet() throws IOException {
            if (entPos == entLen) {
                int r = src.lire(ent, 0, ent.length);
                if (r <= 0) return false;
                entPos = 0; entLen = r;
            }
            tampon |= (long) (ent[entPos++] & 0xff) << nbits;
            nbits += 8;
            return true;
        }

        private int bits(int n) throws IOException {
            while (nbits < n) if (!remplirOctet()) throw new IOException("donnees Deflate64 tronquees");
            int v = (int) (tampon & ((1L << n) - 1));
            tampon >>>= n; nbits -= n;
            return v;
        }

        private int symbole(Huff h) throws IOException {
            while (nbits < 15 && remplirOctet()) { }
            short e = h.rapide[(int) (tampon & ((1 << RAPIDE) - 1))];
            if (e != 0) {
                int l = e & 15;
                if (l <= nbits) { tampon >>>= l; nbits -= l; return e >> 4; }
                throw new IOException("donnees Deflate64 tronquees");
            }
            int code = 0, premier = 0, index = 0;
            for (int l = 1; l <= 15; l++) {
                if (nbits == 0) throw new IOException("donnees Deflate64 tronquees");
                code |= (int) (tampon & 1); tampon >>>= 1; nbits--;
                int c = h.compte[l];
                if (code - c < premier) return h.symbole[index + (code - premier)];
                index += c; premier += c; premier <<= 1; code <<= 1;
            }
            throw abime("code de Huffman invalide");
        }

        private void entete() throws IOException {
            dernier = bits(1) == 1;
            int type = bits(2);
            if (type == 0) {
                int saut = nbits & 7; tampon >>>= saut; nbits -= saut;
                int len = bits(16), nlen = bits(16);
                if ((len ^ 0xFFFF) != nlen) throw abime("bloc non compresse de taille incoherente");
                stockeRestant = len;
                etat = STOCKE;
            } else if (type == 1) {
                int[] lg = new int[288 + 32];
                for (int i = 0; i < 144; i++) lg[i] = 8;
                for (int i = 144; i < 256; i++) lg[i] = 9;
                for (int i = 256; i < 280; i++) lg[i] = 7;
                for (int i = 280; i < 288; i++) lg[i] = 8;
                for (int i = 0; i < 32; i++) lg[288 + i] = 5;
                lit.construire(lg, 0, 288);
                dist.construire(lg, 288, 32);
                etat = HUFFMAN;
            } else if (type == 2) {
                int nlit = bits(5) + 257, ndist = bits(5) + 1, nlen = bits(4) + 4;
                if (nlit > 286) throw abime("trop de codes de longueur");
                int[] lg = new int[320];
                for (int i = 0; i < nlen; i++) lg[ORDRE[i]] = bits(3);
                int[] lgl = new int[19];
                System.arraycopy(lg, 0, lgl, 0, 19);
                Huff lc = new Huff();
                if (lc.construire(lgl, 0, 19) != 0) throw abime("codes de longueurs incomplets");
                java.util.Arrays.fill(lg, 0);
                int i = 0;
                while (i < nlit + ndist) {
                    int sym = symbole(lc);
                    if (sym < 16) { lg[i++] = sym; }
                    else {
                        int prec = 0, rep;
                        if (sym == 16) { if (i == 0) throw abime("repetition sans longueur precedente"); prec = lg[i - 1]; rep = 3 + bits(2); }
                        else if (sym == 17) rep = 3 + bits(3);
                        else rep = 11 + bits(7);
                        if (i + rep > nlit + ndist) throw abime("trop de longueurs");
                        while (rep-- > 0) lg[i++] = prec;
                    }
                }
                if (lg[256] == 0) throw abime("pas de code de fin de bloc");
                if (lit.construire(lg, 0, nlit) < 0) throw abime("codes de longueur sur-souscrits");
                if (dist.construire(lg, nlit, ndist) < 0) throw abime("codes de distance sur-souscrits");
                etat = HUFFMAN;
            } else throw abime("type de bloc invalide");
        }

        // Produit au plus len octets dans dst. Renvoie 0 seulement quand le flux est termine.
        int lire(byte[] dst, int off, int len) throws IOException {
            int n = 0;
            while (n < len) {
                if (copieLong > 0) {
                    int k = Math.min(copieLong, len - n);
                    for (int j = 0; j < k; j++) {
                        byte b = fen[(fenPos - copieDist) & 0xFFFF];
                        fen[fenPos] = b; fenPos = (fenPos + 1) & 0xFFFF;
                        dst[off + n++] = b;
                    }
                    sortie += k; copieLong -= k;
                    continue;
                }
                if (etat == FIN) break;
                if (etat == ENTETE) { entete(); continue; }
                if (etat == STOCKE) {
                    if (stockeRestant == 0) { etat = dernier ? FIN : ENTETE; continue; }
                    byte b = (byte) bits(8);
                    fen[fenPos] = b; fenPos = (fenPos + 1) & 0xFFFF;
                    dst[off + n++] = b; sortie++; stockeRestant--;
                    continue;
                }
                int s = symbole(lit);
                if (s < 256) {
                    byte b = (byte) s;
                    fen[fenPos] = b; fenPos = (fenPos + 1) & 0xFFFF;
                    dst[off + n++] = b; sortie++;
                } else if (s == 256) {
                    etat = dernier ? FIN : ENTETE;
                } else {
                    s -= 257;
                    if (s >= 29) throw abime("code de longueur invalide");
                    int longueur = LB[s] + (LE[s] > 0 ? bits(LE[s]) : 0);
                    int ds = symbole(dist);
                    if (ds >= 32) throw abime("code de distance invalide");
                    int d = DB[ds] + (DE[ds] > 0 ? bits(DE[ds]) : 0);
                    if (d > sortie || d > 65536) throw abime("distance au-dela du debut des donnees");
                    copieLong = longueur; copieDist = d;
                }
            }
            return n;
        }
    }

    // ------------------------------------------------------------------ lecteur d'une entree (flux conserve)
    static final class Lecteur {
        File fichier; long taille, modif; String nom; Info info;
        String modpas; byte[] mdpOctets; Dechiffre dech;
        RandomAccessFile raf; Inflater inf; Inflate64 inf64;
        long pos;                 // octets DECOMPRESSES deja produits depuis le debut de l'entree
        long compRestant;         // octets compresses pas encore lus
        CRC32 crc; boolean crcValide;
        byte[] entree = new byte[TAMPON];

        void fermer() {
            try { if (inf != null) inf.end(); } catch (Exception ignore) {}
            try { if (raf != null) raf.close(); } catch (Exception ignore) {}
            inf = null; inf64 = null; raf = null;
        }

        void repartir() throws IOException {
            if (inf != null) { inf.end(); inf = null; }
            inf64 = null;
            raf.seek(info.dataOff);
            pos = 0;
            compRestant = info.csize;
            crc = new CRC32();
            crcValide = info.verifCrc;
            dech = null;
            if ((info.flags & 1) != 0) preparerChiffre();
            if (info.methodeEff == 8) inf = new Inflater(true);
            if (info.methodeEff == 9) {
                final Lecteur moi = this;
                inf64 = new Inflate64(new Inflate64.Source() {
                    public int lire(byte[] b, int off, int len) throws IOException {
                        if (moi.compRestant <= 0) return -1;
                        return lireBrut(moi, b, off, len);
                    }
                });
            }
        }

        // Lit l'en-tete de chiffrement (sel + verification AES, ou 12 octets ZipCrypto), VERIFIE le mot de passe et installe le dechiffreur.
        // raf est place sur le debut des donnees de l'entree ; apres l'appel il est sur le debut des donnees utiles.
        void preparerChiffre() throws IOException {
            if (info.aesForce > 0) {
                int kl = info.aesForce == 1 ? 16 : info.aesForce == 2 ? 24 : 32, sl = kl / 2;
                if (info.csize < sl + 2 + 10) throw new IOException("'" + nom + "' est abime (donnees chiffrees trop courtes)");
                byte[] sel = new byte[sl], verif = new byte[2];
                raf.readFully(sel);
                raf.readFully(verif);
                try {
                    byte[] cle = pbkdf2(mdpOctets, sel, 1000, 2 * kl + 2);
                    if (cle[2 * kl] != verif[0] || cle[2 * kl + 1] != verif[1]) throw new IOException("mot de passe incorrect pour '" + nom + "' (modpas~)");
                    dech = new AesDech(java.util.Arrays.copyOfRange(cle, 0, kl), java.util.Arrays.copyOfRange(cle, kl, 2 * kl));
                } catch (GeneralSecurityException e) {
                    throw new IOException("'" + nom + "' : chiffrement AES indisponible sur cet appareil (" + e.getMessage() + ")");
                }
                compRestant = info.csize - sl - 2 - 10;
            } else {
                if (info.csize < 12) throw new IOException("'" + nom + "' est abime (donnees chiffrees trop courtes)");
                byte[] en = new byte[12];
                raf.readFully(en);
                ZipCryptoDech z = new ZipCryptoDech(mdpOctets);
                z.traiter(en, 0, 12);
                int ctrl = en[11] & 0xff;
                boolean ok = ctrl == (int) ((info.crc >>> 24) & 0xff);
                if (!ok && (info.flags & 8) != 0) ok = ctrl == ((info.heure >>> 8) & 0xff);   // avec descripteur de donnees : octet de l'heure
                if (!ok) throw new IOException("mot de passe incorrect pour '" + nom + "' (modpas~)");
                dech = z;
                compRestant = info.csize - 12;
            }
        }
    }

    private static Lecteur cache;

    // Ouvre un lecteur NEUF (sans cache) apres verification de l'entree.
    private static Lecteur creerLecteur(String chemin, String nom, String modpas) throws IOException {
        File fichier = new File(chemin == null ? "" : chemin);
        if (!fichier.isFile()) throw new IOException("fichier zip introuvable : '" + chemin + "'");
        Info i = chercher(fichier, nom);
        if (i == null) throw new IOException("l'entree '" + nom + "' n'existe pas dans '" + chemin + "' (liste.zip(chemin) donne les noms)");
        boolean chiffre = (i.flags & 1) != 0;
        if (chiffre && (modpas == null || modpas.isEmpty())) throw new IOException("l'entree '" + nom + "' est protegee par un mot de passe : donne-le avec modpas~ (ex : lire.entrer.zip(chemin, nom, modpas~|secret|))");
        if (chiffre && (i.flags & 0x40) != 0) throw new IOException("l'entree '" + nom + "' utilise un chiffrement fort non gere (seuls ZipCrypto et AES sont pris en charge)");
        if (i.methode == 99 && i.aesForce == 0) throw new IOException("l'entree '" + nom + "' utilise un chiffrement non gere (en-tete AES inconnu)");
        if (i.methodeEff != 0 && i.methodeEff != 8 && i.methodeEff != 9) throw new IOException("l'entree '" + nom + "' utilise une compression non geree (methode " + i.methodeEff + ") ; seules 'stockage', 'deflate' et 'deflate64' sont prises en charge");
        Lecteur n = new Lecteur();
        if (chiffre) { n.modpas = modpas; n.mdpOctets = modpas.getBytes(StandardCharsets.UTF_8); }
        n.fichier = fichier; n.taille = fichier.length(); n.modif = fichier.lastModified(); n.nom = nom; n.info = i;
        n.raf = new RandomAccessFile(fichier, "r");
        try {
            byte[] h = new byte[30];
            if (i.enteteOff + 30 > n.taille) throw new IOException("'" + chemin + "' : en-tete de '" + nom + "' abime (archive tronquee ?)");
            n.raf.seek(i.enteteOff);
            n.raf.readFully(h);
            if (u32(h, 0) != 0x04034b50L) throw new IOException("'" + chemin + "' : en-tete de '" + nom + "' abime");
            i.dataOff = i.enteteOff + 30 + u16(h, 26) + u16(h, 28);
            if (i.dataOff + i.csize > n.taille) throw new IOException("'" + chemin + "' : fichier tronque (donnees de '" + nom + "' incompletes)");
            if (i.methodeEff == 0 && !chiffre && i.csize != i.usize) throw new IOException("'" + chemin + "' : '" + nom + "' est abime (tailles incoherentes)");
            if (chiffre && i.methodeEff == 0) {      // stockage chiffre : taille utile = taille des donnees moins l'en-tete et (AES) le HMAC
                long surcout = i.aesForce > 0 ? (i.aesForce == 1 ? 8 : i.aesForce == 2 ? 12 : 16) + 2 + 10 : 12;
                if (i.csize - surcout != i.usize) throw new IOException("'" + chemin + "' : '" + nom + "' est abime (tailles incoherentes)");
            }
            n.repartir();
        } catch (IOException | RuntimeException e) {
            n.fermer();
            throw e instanceof IOException ? (IOException) e : new IOException(String.valueOf(e.getMessage()));
        }
        return n;
    }

    // Lecteur CONSERVE pour lire.entrer.zip : reutilise tant que le fichier et le nom sont les memes (et que le fichier n'a pas change).
    private static Lecteur ouvrirLecteur(String chemin, String nom, String modpas) throws IOException {
        File fichier = new File(chemin == null ? "" : chemin);
        Lecteur l = cache;
        if (l != null && l.nom.equals(nom) && l.fichier.getAbsolutePath().equals(fichier.getAbsolutePath())
                && l.taille == fichier.length() && l.modif == fichier.lastModified()
                && java.util.Objects.equals(l.modpas, (l.info.flags & 1) != 0 ? modpas : null)) return l;
        if (l != null) { l.fermer(); cache = null; }
        cache = creerLecteur(chemin, nom, modpas);
        return cache;
    }

    // Lit des octets BRUTS de l'entree (limites aux donnees de l'entree), les dechiffre si besoin et fait le controle final AES.
    private static int lireBrut(Lecteur l, byte[] buf, int off, int len) throws IOException {
        if (l.compRestant <= 0) throw new IOException("'" + l.info.nom + "' : donnees tronquees");
        int r = l.raf.read(buf, off, (int) Math.min(len, l.compRestant));
        if (r <= 0) throw new IOException("'" + l.info.nom + "' : fichier tronque");
        l.compRestant -= r;
        if (l.dech != null) {
            l.dech.traiter(buf, off, r);
            if (l.compRestant == 0) l.dech.fin(l.raf, l.info.nom);
        }
        return r;
    }

    // Produit "voulu" octets de l'entree a partir de la position courante du lecteur (lecture sequentielle).
    // ecrireDest = false : les octets sont decompresses puis JETES (saut en avant), mais comptes dans le CRC32.
    private static void produire(Lecteur l, byte[] dest, int off, int voulu, boolean ecrireDest) throws IOException {
        Info i = l.info;
        byte[] jet = ecrireDest ? null : new byte[TAMPON];
        int fait = 0;
        while (fait < voulu) {
            byte[] cible = ecrireDest ? dest : jet;
            int debut = ecrireDest ? off + fait : 0;
            int max = voulu - fait;
            if (!ecrireDest) max = Math.min(max, jet.length);
            int k;
            if (i.methodeEff == 0) {
                if (l.dech == null) {
                    k = l.raf.read(cible, debut, max);
                    if (k <= 0) throw new IOException("'" + i.nom + "' : fichier tronque");
                } else {
                    k = lireBrut(l, cible, debut, max);
                }
            } else if (i.methodeEff == 9) {
                k = l.inf64.lire(cible, debut, max);
                if (k <= 0) throw new IOException("'" + i.nom + "' est abime (moins de donnees que prevu)");
            } else {
                while (true) {
                    if (l.inf.needsInput()) {
                        if (l.compRestant <= 0) throw new IOException("'" + i.nom + "' : donnees compressees tronquees");
                        int r = lireBrut(l, l.entree, 0, l.entree.length);
                        l.inf.setInput(l.entree, 0, r);
                    }
                    try { k = l.inf.inflate(cible, debut, max); }
                    catch (DataFormatException e) { throw new IOException("'" + i.nom + "' : donnees compressees abimees"); }
                    if (k > 0) break;
                    if (l.inf.finished()) throw new IOException("'" + i.nom + "' est abime (moins de donnees que prevu)");
                    if (l.inf.needsDictionary()) throw new IOException("'" + i.nom + "' : donnees compressees non gerees");
                }
            }
            if (l.crcValide) l.crc.update(cible, debut, k);
            fait += k;
            l.pos += k;
        }
    }

    private static void verifierFin(Lecteur l) throws IOException {
        if (l.pos == l.info.usize && l.crcValide && l.crc.getValue() != l.info.crc) {
            cache = (cache == l) ? null : cache;
            l.fermer();
            throw new IOException("'" + l.info.nom + "' est abime (la signature CRC32 ne correspond pas)");
        }
    }

    // ------------------------------------------------------------------ lire.entrer.zip(chemin, nom, debut~, longueur~)
    public static String info(String chemin, String nom) { return info(chemin, nom, null); }

    public static synchronized String info(String chemin, String nom, String modpas) {
        try {
            Lecteur l = ouvrirLecteur(chemin, nom, modpas);
            return "OK:" + l.info.usize;
        } catch (IOException | RuntimeException e) {
            return "ERR:" + e.getMessage();
        }
    }

    // Lit "longueur" octets a partir de debut0 (decalage depuis 0). Hors fin : octets vides / lecture jusqu'a la fin.
    public static byte[] lireOctets(String chemin, String nom, double debut0, int longueur) throws IOException {
        return lireOctets(chemin, nom, debut0, longueur, null);
    }

    public static synchronized byte[] lireOctets(String chemin, String nom, double debut0, int longueur, String modpas) throws IOException {
        Lecteur l;
        try { l = ouvrirLecteur(chemin, nom, modpas); }
        catch (RuntimeException e) { throw new IOException(e.getMessage()); }
        long d = (long) debut0, usize = l.info.usize;
        if (d < 0) throw new IOException("position de lecture negative");
        if (d >= usize || longueur <= 0) return new byte[0];
        long n = Math.min((long) longueur, usize - d);
        if (n > MAX_LECTURE) throw new IOException("lecture de " + n + " octets d'un coup : trop grand (maximum " + MAX_LECTURE + " par appel)");
        byte[] out = new byte[(int) n];
        try {
            if (l.info.methodeEff == 0 && l.dech == null) {
                if (l.pos != d) {                                   // acces direct ; le CRC n'est verifiable que depuis le debut
                    l.raf.seek(l.info.dataOff + d);
                    l.pos = d;
                    if (d == 0) { l.crc = new CRC32(); l.crcValide = true; } else l.crcValide = false;
                }
            } else {
                if (d < l.pos) l.repartir();                        // retour en arriere : on repart du debut de l'entree
                if (d > l.pos) saute(l, d - l.pos);                 // en avant : on decompresse et on jette
            }
            produire(l, out, 0, out.length, true);
            verifierFin(l);
        } catch (IOException | RuntimeException e) {
            if (cache == l) cache = null;
            l.fermer();
            throw e instanceof IOException ? (IOException) e : new IOException(String.valueOf(e.getMessage()));
        }
        return out;
    }

    private static void saute(Lecteur l, long n) throws IOException {
        while (n > 0) {
            int k = (int) Math.min(n, 1 << 20);
            produire(l, null, 0, k, false);
            n -= k;
        }
    }

    public static synchronized String fermer() {
        if (cache != null) { cache.fermer(); cache = null; }
        return "OK";
    }

    // ------------------------------------------------------------------ extrait.entrer.zip(chemin, nom, destination) : pas a pas
    private static final class Extraction {
        Lecteur l; File dest, part; boolean ecra; FileOutputStream out; byte[] tmp = new byte[TAMPON];
    }
    private static Extraction ex;

    private static void nettoyerExtraction() {
        Extraction e = ex;
        ex = null;
        if (e == null) return;
        try { if (e.out != null) e.out.close(); } catch (Exception ignore) {}
        if (e.l != null) e.l.fermer();
        if (e.part != null) e.part.delete();
    }

    public static String extraireDebut(String chemin, String nom, String destination, boolean ecra) { return extraireDebut(chemin, nom, destination, ecra, null); }

    public static synchronized String extraireDebut(String chemin, String nom, String destination, boolean ecra, String modpas) {
        nettoyerExtraction();
        try {
            if (destination == null || destination.trim().isEmpty()) return "ERR:destination vide";
            File dest = new File(destination);
            if (dest.isDirectory()) return "ERR:'" + destination + "' est un dossier";
            if (!ecra && dest.exists()) return "ERR:le fichier existe deja : '" + destination + "' (utilise ecra~VRAI pour le remplacer)";
            File parent = dest.getAbsoluteFile().getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) return "ERR:impossible de creer le dossier '" + parent.getPath() + "'";
            Extraction e = new Extraction();
            e.l = creerLecteur(chemin, nom, modpas);            // lecteur DEDIE : le lecteur conserve de lire.entrer.zip n'est pas touche
            e.dest = dest; e.ecra = ecra; e.part = new File(dest.getPath() + ".part");
            if (e.part.exists() && !e.part.delete()) { e.l.fermer(); return "ERR:impossible de supprimer l'ancien fichier temporaire '" + e.part.getPath() + "'"; }
            e.out = new FileOutputStream(e.part);
            ex = e;
            return "OK:" + e.l.info.usize;
        } catch (IOException | RuntimeException e) {
            nettoyerExtraction();
            return "ERR:" + e.getMessage();
        }
    }

    // "OK:1" s'il reste des donnees, "OK:0" quand tout est ecrit, verifie (CRC32) et renomme.
    public static synchronized String extrairePas(int maxOctets) {
        Extraction e = ex;
        if (e == null) return "ERR:aucune extraction en cours";
        try {
            if (maxOctets <= 0) maxOctets = 2 * 1024 * 1024;
            Lecteur l = e.l;
            long reste = l.info.usize - l.pos;
            int pas = (int) Math.min(reste, (long) maxOctets);
            int fait = 0;
            while (fait < pas) {
                int k = Math.min(e.tmp.length, pas - fait);
                produire(l, e.tmp, 0, k, true);
                e.out.write(e.tmp, 0, k);
                fait += k;
            }
            if (l.pos < l.info.usize) return "OK:1";
            verifierFin(l);
            e.out.close();
            e.out = null;
            l.fermer();
            ex = null;
            File dest = e.dest, part = e.part;
            if (!e.ecra && dest.exists()) { part.delete(); return "ERR:le fichier '" + dest.getPath() + "' existe deja (cree pendant l'extraction)"; }
            if (part.renameTo(dest)) return "OK:0";
            File vieux = new File(dest.getPath() + ".old");
            if (dest.exists()) {
                if (vieux.exists()) vieux.delete();
                if (!dest.renameTo(vieux)) { part.delete(); return "ERR:impossible de remplacer '" + dest.getPath() + "'"; }
                if (part.renameTo(dest)) { vieux.delete(); return "OK:0"; }
                vieux.renameTo(dest);
            }
            part.delete();
            return "ERR:impossible de renommer le fichier temporaire en '" + dest.getPath() + "'";
        } catch (IOException | RuntimeException ex2) {
            nettoyerExtraction();
            return "ERR:" + ex2.getMessage();
        }
    }

    public static synchronized String extraireAbandon() {
        nettoyerExtraction();
        return "OK";
    }
}
