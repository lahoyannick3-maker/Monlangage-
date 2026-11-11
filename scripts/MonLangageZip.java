package __APPID__;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.HashMap;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

// Ecriture ZIP PROGRESSIVE (ouvrir.zip / entrer.zip / ajout.zip du langage MLG).
// - L'archive est ecrite dans "chemin.part" puis renommee seulement a la fin NORMALE (finaliser) : un ancien fichier
//   valide n'est jamais detruit avant que la nouvelle archive soit entierement ecrite et synchronisee sur le disque.
// - Aucune donnee n'est accumulee en memoire : seul le morceau en cours (+ un tampon de 64 Ko) existe. Le repertoire
//   central est ecrit au fur et a mesure dans "chemin.part.cd" puis recopie a la fin du .part.
// - Les tailles et le CRC32 d'une entree ne sont connus qu'a sa fin : l'en-tete local est ecrit avec des zeros puis
//   CORRIGE a la fin de l'entree (la sortie est un vrai fichier : pas de "data descriptor").
// - ZIP64 : decide pour chaque limite separement (taille d'une entree, position d'une entree, nombre d'entrees,
//   taille/position du repertoire central).
// Toutes les methodes publiques renvoient "OK", "OK:valeur" ou "ERR:message". Aucune ne leve d'exception.
// N'utilise QUE java.io / java.util (compatible Android API 22+, pas de java.nio.file).
public final class MonLangageZip {
    private MonLangageZip() {}

    private static final long MAX32 = 0xFFFFFFFEL;       // 0xFFFFFFFF signifie "voir l'extra ZIP64"
    private static final int MAX_ARCHIVES = 8;
    private static final int TAMPON = 64 * 1024;

    private static final HashMap<Integer, Archive> archives = new HashMap<>();
    private static int prochainId = 1;

    // ------------------------------------------------------------------ ensemble de signatures 64 bits (noms)
    private static final class LongSet {
        long[] t = new long[1024];
        int n = 0;
        static long mix(long h) { return h == 0 ? 1 : h; }
        boolean contient(long h) {
            h = mix(h);
            int m = t.length - 1;
            int i = (int) (h ^ (h >>> 32)) & m;
            while (t[i] != 0) { if (t[i] == h) return true; i = (i + 1) & m; }
            return false;
        }
        void ajoute(long h) {
            h = mix(h);
            if ((n + 1) * 2 > t.length) agrandir();
            int m = t.length - 1;
            int i = (int) (h ^ (h >>> 32)) & m;
            while (t[i] != 0) { if (t[i] == h) return; i = (i + 1) & m; }
            t[i] = h; n++;
        }
        void agrandir() {
            long[] ancien = t;
            t = new long[ancien.length * 2];
            n = 0;
            for (long v : ancien) if (v != 0) ajoute(v);
        }
    }

    private static long signature(byte[] nom) {   // FNV-1a 64 bits
        long h = 0xcbf29ce484222325L;
        for (byte b : nom) { h ^= (b & 0xff); h *= 0x100000001b3L; }
        return h;
    }

    // ------------------------------------------------------------------ sortie bufferisee avec correction d'en-tete
    private static final class Sortie {
        final RandomAccessFile f;
        final byte[] buf = new byte[TAMPON];
        int n = 0;
        long pos = 0;      // position logique (fin du fichier)
        Sortie(RandomAccessFile f) { this.f = f; }
        void ecrire(byte[] b, int off, int len) throws IOException {
            pos += len;
            while (len > 0) {
                if (n == buf.length) vider();
                int k = Math.min(len, buf.length - n);
                System.arraycopy(b, off, buf, n, k);
                n += k; off += k; len -= k;
            }
        }
        void vider() throws IOException { if (n > 0) { f.write(buf, 0, n); n = 0; } }
        void corriger(long decalage, byte[] b) throws IOException {
            vider();
            f.seek(decalage);
            f.write(b, 0, b.length);
            f.seek(pos);
        }
    }

    private static final class Entree {
        byte[] nom;
        boolean utf8;
        int methode;               // 0 = stocke, 8 = deflate
        long enteteOff;
        boolean zip64;             // place ZIP64 reservee dans l'en-tete local
        int heure, date;
        CRC32 crc = new CRC32();
        Deflater def;
        long taille = 0, compresse = 0;
    }

    private static final class Archive {
        int id;
        File dest, part, cd;
        String cle;
        boolean compressDefaut, ecra;
        Sortie out;
        BufferedOutputStream cdOut;
        long nbEntrees = 0, cdTaille = 0;
        LongSet noms = new LongSet();
        Entree cur;
        boolean cassee = false;
        byte[] tmp = new byte[TAMPON];
    }

    private static String ok() { return "OK"; }
    private static String ok(String v) { return "OK:" + v; }
    private static String err(String m) { return "ERR:" + m; }

    private static String cleChemin(File f) {
        try { return f.getCanonicalPath(); } catch (IOException e) { return f.getAbsolutePath(); }
    }

    // ------------------------------------------------------------------ ouverture
    public static synchronized String ouvrir(String chemin, boolean compress, boolean ecra) {
        Archive a = null;
        try {
            if (chemin == null || chemin.trim().isEmpty()) return err("chemin vide");
            File dest = new File(chemin);
            if (dest.isDirectory()) return err("'" + chemin + "' est un dossier");
            String cle = cleChemin(dest);
            for (Archive b : archives.values()) {
                if (b.cle.equals(cle)) return err("une archive est deja ouverte sur '" + chemin + "' (ferme-la ou choisis un autre chemin)");
            }
            if (archives.size() >= MAX_ARCHIVES) return err("trop d'archives ouvertes en meme temps (maximum " + MAX_ARCHIVES + ")");
            if (!ecra && dest.exists()) return err("le fichier existe deja : '" + chemin + "' (utilise ecra~VRAI pour le remplacer)");
            File parent = dest.getAbsoluteFile().getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) return err("impossible de creer le dossier '" + parent.getPath() + "'");
            a = new Archive();
            a.dest = dest;
            a.part = new File(dest.getPath() + ".part");
            a.cd = new File(dest.getPath() + ".part.cd");
            a.cle = cle;
            a.compressDefaut = compress;
            a.ecra = ecra;
            // restes d'une execution interrompue (aucune archive ouverte ne les utilise : verifie ci-dessus)
            if (a.part.exists() && !a.part.delete()) return err("impossible de supprimer l'ancien fichier temporaire '" + a.part.getPath() + "'");
            if (a.cd.exists() && !a.cd.delete()) return err("impossible de supprimer l'ancien fichier temporaire '" + a.cd.getPath() + "'");
            RandomAccessFile raf = new RandomAccessFile(a.part, "rw");
            raf.setLength(0);
            a.out = new Sortie(raf);
            a.cdOut = new BufferedOutputStream(new FileOutputStream(a.cd), TAMPON);
            a.id = prochainId++;
            archives.put(a.id, a);
            return ok(String.valueOf(a.id));
        } catch (Exception | OutOfMemoryError e) {
            if (a != null) nettoyer(a);
            return err("ouverture impossible : " + e.getMessage());
        }
    }

    private static Archive trouver(int id) { return archives.get(id); }

    // ------------------------------------------------------------------ entrees
    // compress : -1 = valeur de l'archive, 0 = stocke, 1 = deflate. tailleConnue : -1 si inconnue.
    // reserveZip64 : reserve la place ZIP64 dans l'en-tete local (entrees par morceaux pouvant depasser 4 Go).
    public static synchronized String entrer(int id, String nom, int compress, double tailleConnue, boolean reserveZip64) {
        Archive a = trouver(id);
        if (a == null) return err("archive fermee ou inconnue");
        if (a.cassee) return err("archive cassee par une erreur precedente");
        if (a.cur != null) return err("une entree est deja ouverte : " + new String(a.cur.nom, StandardCharsets.UTF_8));
        if (nom == null || nom.isEmpty()) return err("nom d'entree vide");
        if (nom.endsWith("/")) return err("le nom d'une entree ne peut pas finir par / : '" + nom + "'");
        byte[] nomB = nom.getBytes(StandardCharsets.UTF_8);
        if (nomB.length > 65535) return err("nom d'entree trop long (" + nomB.length + " octets, maximum 65535)");
        long sig = signature(nomB);
        try {
            if (a.noms.contient(sig) && nomExiste(a, nomB)) return err("l'entree '" + nom + "' existe deja dans l'archive");
            Entree e = new Entree();
            e.nom = nomB;
            for (byte b : nomB) if (b < 0) { e.utf8 = true; break; }
            boolean comp = compress < 0 ? a.compressDefaut : compress == 1;
            e.methode = comp ? 8 : 0;
            e.zip64 = reserveZip64 || tailleConnue >= (double) 0xF0000000L;
            Calendar c = Calendar.getInstance();
            int an = Math.max(1980, c.get(Calendar.YEAR));
            e.heure = (c.get(Calendar.HOUR_OF_DAY) << 11) | (c.get(Calendar.MINUTE) << 5) | (c.get(Calendar.SECOND) / 2);
            e.date = ((an - 1980) << 9) | ((c.get(Calendar.MONTH) + 1) << 5) | c.get(Calendar.DAY_OF_MONTH);
            e.enteteOff = a.out.pos;
            if (comp) e.def = new Deflater(Deflater.DEFAULT_COMPRESSION, true);
            int extraLen = e.zip64 ? 20 : 0;
            ByteBuffer h = ByteBuffer.allocate(30 + nomB.length + extraLen).order(ByteOrder.LITTLE_ENDIAN);
            h.putInt(0x04034b50);
            h.putShort((short) (e.zip64 ? 45 : 20));
            h.putShort((short) (e.utf8 ? 0x0800 : 0));
            h.putShort((short) e.methode);
            h.putShort((short) e.heure);
            h.putShort((short) e.date);
            h.putInt(0);                                   // crc (corrige a la fin)
            h.putInt(e.zip64 ? 0xFFFFFFFF : 0);            // taille compressee (corrigee a la fin)
            h.putInt(e.zip64 ? 0xFFFFFFFF : 0);            // taille reelle (corrigee a la fin)
            h.putShort((short) nomB.length);
            h.putShort((short) extraLen);
            h.put(nomB);
            if (e.zip64) { h.putShort((short) 1); h.putShort((short) 16); h.putLong(0); h.putLong(0); }
            a.out.ecrire(h.array(), 0, h.capacity());
            a.noms.ajoute(sig);
            a.cur = e;
            return ok();
        } catch (IOException | RuntimeException | OutOfMemoryError ex) {
            a.cassee = true;
            return err("ecriture impossible : " + ex.getMessage());
        }
    }

    public static synchronized String ecrire(int id, byte[] morceau) {
        Archive a = trouver(id);
        if (a == null) return err("archive fermee ou inconnue");
        if (a.cassee) return err("archive cassee par une erreur precedente");
        Entree e = a.cur;
        if (e == null) return err("aucune entree ouverte");
        try {
            return ecrireInterne(a, e, morceau, 0, morceau.length);
        } catch (IOException | RuntimeException | OutOfMemoryError ex) {
            a.cassee = true;
            return err("ecriture impossible : " + ex.getMessage());
        }
    }

    private static String ecrireInterne(Archive a, Entree e, byte[] b, int off, int len) throws IOException {
        if (len == 0) return ok();
        if (!e.zip64 && e.taille + len > MAX32) {
            a.cassee = true;
            return err("l'entree depasse 4 Go : non prise en charge pour une entree ecrite par morceaux sans ZIP64");
        }
        e.crc.update(b, off, len);
        e.taille += len;
        if (e.def == null) {
            a.out.ecrire(b, off, len);
            e.compresse += len;
        } else {
            e.def.setInput(b, off, len);
            while (!e.def.needsInput()) {
                int k = e.def.deflate(a.tmp);
                if (k > 0) { a.out.ecrire(a.tmp, 0, k); e.compresse += k; }
            }
        }
        if (!e.zip64 && e.compresse > MAX32) {
            a.cassee = true;
            return err("l'entree compressee depasse 4 Go : non prise en charge sans ZIP64");
        }
        return ok();
    }

    public static synchronized String finEntree(int id) {
        Archive a = trouver(id);
        if (a == null) return err("archive fermee ou inconnue");
        if (a.cassee) return err("archive cassee par une erreur precedente");
        Entree e = a.cur;
        if (e == null) return err("aucune entree ouverte");
        try {
            if (e.def != null) {
                e.def.finish();
                while (!e.def.finished()) {
                    int k = e.def.deflate(a.tmp);
                    if (k > 0) { a.out.ecrire(a.tmp, 0, k); e.compresse += k; }
                }
                e.def.end();
                e.def = null;
            }
            if (!e.zip64 && (e.taille > MAX32 || e.compresse > MAX32)) {
                a.cassee = true;
                return err("l'entree depasse 4 Go : non prise en charge sans ZIP64");
            }
            long crc = e.crc.getValue();
            // 1) correction de l'en-tete local
            ByteBuffer p = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN);
            p.putInt((int) crc);
            p.putInt(e.zip64 ? 0xFFFFFFFF : (int) e.compresse);
            p.putInt(e.zip64 ? 0xFFFFFFFF : (int) e.taille);
            a.out.corriger(e.enteteOff + 14, p.array());
            if (e.zip64) {
                ByteBuffer x = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN);
                x.putLong(e.taille);
                x.putLong(e.compresse);
                a.out.corriger(e.enteteOff + 30 + e.nom.length + 4, x.array());
            }
            // 2) enregistrement du repertoire central
            boolean tailleGrande = e.taille > MAX32, compGrande = e.compresse > MAX32, offGrand = e.enteteOff > MAX32;
            int nbExtra = (tailleGrande ? 8 : 0) + (compGrande ? 8 : 0) + (offGrand ? 8 : 0);
            int extraLen = nbExtra > 0 ? 4 + nbExtra : 0;
            boolean v45 = e.zip64 || nbExtra > 0;
            ByteBuffer c = ByteBuffer.allocate(46 + e.nom.length + extraLen).order(ByteOrder.LITTLE_ENDIAN);
            c.putInt(0x02014b50);
            c.putShort((short) (v45 ? 45 : 20));
            c.putShort((short) (v45 ? 45 : 20));
            c.putShort((short) (e.utf8 ? 0x0800 : 0));
            c.putShort((short) e.methode);
            c.putShort((short) e.heure);
            c.putShort((short) e.date);
            c.putInt((int) crc);
            c.putInt(compGrande ? 0xFFFFFFFF : (int) e.compresse);
            c.putInt(tailleGrande ? 0xFFFFFFFF : (int) e.taille);
            c.putShort((short) e.nom.length);
            c.putShort((short) extraLen);
            c.putShort((short) 0);          // commentaire
            c.putShort((short) 0);          // disque
            c.putShort((short) 0);          // attributs internes
            c.putInt(0);                    // attributs externes
            c.putInt(offGrand ? 0xFFFFFFFF : (int) e.enteteOff);
            c.put(e.nom);
            if (extraLen > 0) {
                c.putShort((short) 1);
                c.putShort((short) nbExtra);
                if (tailleGrande) c.putLong(e.taille);
                if (compGrande) c.putLong(e.compresse);
                if (offGrand) c.putLong(e.enteteOff);
            }
            a.cdOut.write(c.array(), 0, c.capacity());
            a.cdTaille += c.capacity();
            a.nbEntrees++;
            a.cur = null;
            return ok();
        } catch (IOException | RuntimeException | OutOfMemoryError ex) {
            a.cassee = true;
            return err("ecriture impossible : " + ex.getMessage());
        }
    }

    // Ajoute un fichier du telephone, lu par morceaux directement par Java (rien ne passe par le JS).
    public static synchronized String ajouterFichier(int id, String nom, String source, int compress) {
        Archive a = trouver(id);
        if (a == null) return err("archive fermee ou inconnue");
        File src = new File(source == null ? "" : source);
        if (!src.isFile()) return err("fichier source introuvable : '" + source + "'");
        long taille = src.length();
        String r = entrer(id, nom, compress, (double) taille, false);
        if (!r.startsWith("OK")) return r;
        Entree e = a.cur;
        try (FileInputStream in = new FileInputStream(src)) {
            byte[] b = new byte[TAMPON];
            int k;
            while ((k = in.read(b)) > 0) {
                String s = ecrireInterne(a, e, b, 0, k);
                if (!s.startsWith("OK")) return s;
            }
        } catch (IOException | RuntimeException | OutOfMemoryError ex) {
            a.cassee = true;
            return err("lecture de '" + source + "' impossible : " + ex.getMessage());
        }
        return finEntree(id);
    }

    // Detection d'un vrai doublon (apres un test positif sur l'ensemble de signatures) : relit le repertoire central.
    private static boolean nomExiste(Archive a, byte[] nom) throws IOException {
        if (a.cur != null && java.util.Arrays.equals(a.cur.nom, nom)) return true;
        a.cdOut.flush();
        try (java.io.DataInputStream in = new java.io.DataInputStream(new java.io.BufferedInputStream(new FileInputStream(a.cd), TAMPON))) {
            byte[] enT = new byte[46];
            long restant = a.cdTaille;
            while (restant >= 46) {
                in.readFully(enT);
                ByteBuffer h = ByteBuffer.wrap(enT).order(ByteOrder.LITTLE_ENDIAN);
                int ln = h.getShort(28) & 0xFFFF, le = h.getShort(30) & 0xFFFF, lc = h.getShort(32) & 0xFFFF;
                byte[] n = new byte[ln];
                in.readFully(n);
                long saut = le + lc;
                while (saut > 0) { long s = in.skip(saut); if (s <= 0) break; saut -= s; }
                restant -= 46 + ln + le + lc;
                if (java.util.Arrays.equals(n, nom)) return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ fin normale
    public static synchronized String finaliser(int id) {
        Archive a = trouver(id);
        if (a == null) return err("archive fermee ou inconnue");
        if (a.cassee) { return err("archive cassee par une erreur precedente"); }
        if (a.cur != null) return err("une entree est encore ouverte : " + new String(a.cur.nom, StandardCharsets.UTF_8));
        try {
            a.cdOut.flush();
            a.cdOut.close();
            a.cdOut = null;
            long cdDebut = a.out.pos;
            try (FileInputStream in = new FileInputStream(a.cd)) {
                int k;
                while ((k = in.read(a.tmp)) > 0) a.out.ecrire(a.tmp, 0, k);
            }
            long cdTaille = a.cdTaille;
            boolean z64 = a.nbEntrees > 0xFFFE || cdTaille > MAX32 || cdDebut > MAX32;
            if (z64) {
                long z64Off = a.out.pos;
                ByteBuffer z = ByteBuffer.allocate(56 + 20).order(ByteOrder.LITTLE_ENDIAN);
                z.putInt(0x06064b50);
                z.putLong(44);
                z.putShort((short) 45);
                z.putShort((short) 45);
                z.putInt(0);
                z.putInt(0);
                z.putLong(a.nbEntrees);
                z.putLong(a.nbEntrees);
                z.putLong(cdTaille);
                z.putLong(cdDebut);
                z.putInt(0x07064b50);
                z.putInt(0);
                z.putLong(z64Off);
                z.putInt(1);
                a.out.ecrire(z.array(), 0, z.capacity());
            }
            ByteBuffer f = ByteBuffer.allocate(22).order(ByteOrder.LITTLE_ENDIAN);
            f.putInt(0x06054b50);
            f.putShort((short) 0);
            f.putShort((short) 0);
            short n16 = (short) (a.nbEntrees > 0xFFFE ? 0xFFFF : a.nbEntrees);
            f.putShort(n16);
            f.putShort(n16);
            f.putInt(cdTaille > MAX32 ? 0xFFFFFFFF : (int) cdTaille);
            f.putInt(cdDebut > MAX32 ? 0xFFFFFFFF : (int) cdDebut);
            f.putShort((short) 0);
            a.out.ecrire(f.array(), 0, 22);
            a.out.vider();
            a.out.f.getFD().sync();
            a.out.f.close();
            a.out = null;
        } catch (IOException | RuntimeException | OutOfMemoryError ex) {
            a.cassee = true;
            return err("finalisation impossible : " + ex.getMessage());
        }
        // renommage : l'ancien fichier n'est touche qu'ici, quand la nouvelle archive est COMPLETE
        archives.remove(a.id);
        a.cd.delete();
        if (!a.ecra && a.dest.exists()) {
            return err("le fichier '" + a.dest.getPath() + "' existe deja (cree pendant l'ecriture) : l'archive terminee est conservee dans '" + a.part.getPath() + "'");
        }
        if (a.part.renameTo(a.dest)) return ok();
        File vieux = new File(a.dest.getPath() + ".old");
        if (a.dest.exists()) {
            if (vieux.exists()) vieux.delete();
            if (!a.dest.renameTo(vieux)) return err("impossible de remplacer '" + a.dest.getPath() + "' : l'archive terminee est conservee dans '" + a.part.getPath() + "'");
            if (a.part.renameTo(a.dest)) { vieux.delete(); return ok(); }
            vieux.renameTo(a.dest);   // on remet l'ancien fichier en place
        }
        return err("impossible de renommer '" + a.part.getPath() + "' en '" + a.dest.getPath() + "' : l'archive terminee est conservee sous le nom .part");
    }

    // ------------------------------------------------------------------ abandon
    private static void nettoyer(Archive a) {
        try { if (a.cur != null && a.cur.def != null) a.cur.def.end(); } catch (Exception ignore) {}
        try { if (a.cdOut != null) a.cdOut.close(); } catch (Exception ignore) {}
        try { if (a.out != null) a.out.f.close(); } catch (Exception ignore) {}
        if (a.part != null) a.part.delete();
        if (a.cd != null) a.cd.delete();
        archives.remove(a.id);
    }

    public static synchronized String abandonner(int id) {
        Archive a = trouver(id);
        if (a == null) return ok();      // deja fermee ou abandonnee : sans effet
        nettoyer(a);
        return ok();
    }

    public static synchronized String abandonnerTout() {
        for (Archive a : new java.util.ArrayList<>(archives.values())) nettoyer(a);
        return ok();
    }

    // Nombre d'archives ouvertes (tests)
    public static synchronized int nbOuvertes() { return archives.size(); }
}
