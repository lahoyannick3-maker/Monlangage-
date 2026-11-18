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
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

// Lecture ZIP de GROS fichiers (liste.zip / lire.zip(chemin, nom) / extrai.zip du langage MLG).
// - Le repertoire central est lu par morceaux directement dans le fichier : jamais le zip entier en memoire.
// - Lecture par morceaux : une entree NON compressee se lit a n'importe quelle position ; une entree COMPRESSEE se lit
//   depuis son debut (le deflate est sequentiel). Le dernier flux ouvert est CONSERVE : si l'appel suivant demande
//   exactement la suite, on continue sans repartir du debut ; sinon (retour en arriere) on repart du debut.
// - Le CRC32 est verifie des que l'entree a ete lue en entier d'un seul tenant depuis son debut.
// - ZIP64 : EOCD ZIP64, tailles et positions ZIP64 des entrees.
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
        int flags, methode;
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

    // ------------------------------------------------------------------ lecteur d'une entree (flux conserve)
    static final class Lecteur {
        File fichier; long taille, modif; String nom; Info info;
        RandomAccessFile raf; Inflater inf;
        long pos;                 // octets DECOMPRESSES deja produits depuis le debut de l'entree
        long compRestant;         // octets compresses pas encore lus
        CRC32 crc; boolean crcValide;
        byte[] entree = new byte[TAMPON];

        void fermer() {
            try { if (inf != null) inf.end(); } catch (Exception ignore) {}
            try { if (raf != null) raf.close(); } catch (Exception ignore) {}
            inf = null; raf = null;
        }

        void repartir() throws IOException {
            if (inf != null) { inf.end(); inf = null; }
            raf.seek(info.dataOff);
            pos = 0;
            compRestant = info.csize;
            crc = new CRC32();
            crcValide = true;
            if (info.methode == 8) inf = new Inflater(true);
        }
    }

    private static Lecteur cache;

    // Ouvre un lecteur NEUF (sans cache) apres verification de l'entree.
    private static Lecteur creerLecteur(String chemin, String nom) throws IOException {
        File fichier = new File(chemin == null ? "" : chemin);
        if (!fichier.isFile()) throw new IOException("fichier zip introuvable : '" + chemin + "'");
        Info i = chercher(fichier, nom);
        if (i == null) throw new IOException("l'entree '" + nom + "' n'existe pas dans '" + chemin + "' (liste.zip(chemin) donne les noms)");
        if ((i.flags & 1) != 0) throw new IOException("l'entree '" + nom + "' est protegee par un mot de passe (non gere)");
        if (i.methode != 0 && i.methode != 8) throw new IOException("l'entree '" + nom + "' utilise une compression non geree (methode " + i.methode + ") ; seules 'stockage' et 'deflate' sont prises en charge");
        Lecteur n = new Lecteur();
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
            if (i.methode == 0 && i.csize != i.usize) throw new IOException("'" + chemin + "' : '" + nom + "' est abime (tailles incoherentes)");
            n.repartir();
        } catch (IOException | RuntimeException e) {
            n.fermer();
            throw e instanceof IOException ? (IOException) e : new IOException(String.valueOf(e.getMessage()));
        }
        return n;
    }

    // Lecteur CONSERVE pour lire.zip : reutilise tant que le fichier et le nom sont les memes (et que le fichier n'a pas change).
    private static Lecteur ouvrirLecteur(String chemin, String nom) throws IOException {
        File fichier = new File(chemin == null ? "" : chemin);
        Lecteur l = cache;
        if (l != null && l.nom.equals(nom) && l.fichier.getAbsolutePath().equals(fichier.getAbsolutePath())
                && l.taille == fichier.length() && l.modif == fichier.lastModified()) return l;
        if (l != null) { l.fermer(); cache = null; }
        cache = creerLecteur(chemin, nom);
        return cache;
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
            if (i.methode == 0) {
                k = l.raf.read(cible, debut, max);
                if (k <= 0) throw new IOException("'" + i.nom + "' : fichier tronque");
            } else {
                while (true) {
                    if (l.inf.needsInput()) {
                        if (l.compRestant <= 0) throw new IOException("'" + i.nom + "' : donnees compressees tronquees");
                        int r = l.raf.read(l.entree, 0, (int) Math.min(l.entree.length, l.compRestant));
                        if (r <= 0) throw new IOException("'" + i.nom + "' : fichier tronque");
                        l.compRestant -= r;
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

    // ------------------------------------------------------------------ lire.zip(chemin, nom, debut~, longueur~)
    public static synchronized String info(String chemin, String nom) {
        try {
            Lecteur l = ouvrirLecteur(chemin, nom);
            return "OK:" + l.info.usize;
        } catch (IOException | RuntimeException e) {
            return "ERR:" + e.getMessage();
        }
    }

    // Lit "longueur" octets a partir de debut0 (decalage depuis 0). Hors fin : octets vides / lecture jusqu'a la fin.
    public static synchronized byte[] lireOctets(String chemin, String nom, double debut0, int longueur) throws IOException {
        Lecteur l;
        try { l = ouvrirLecteur(chemin, nom); }
        catch (RuntimeException e) { throw new IOException(e.getMessage()); }
        long d = (long) debut0, usize = l.info.usize;
        if (d < 0) throw new IOException("position de lecture negative");
        if (d >= usize || longueur <= 0) return new byte[0];
        long n = Math.min((long) longueur, usize - d);
        if (n > MAX_LECTURE) throw new IOException("lecture de " + n + " octets d'un coup : trop grand (maximum " + MAX_LECTURE + " par appel)");
        byte[] out = new byte[(int) n];
        try {
            if (l.info.methode == 0) {
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

    // ------------------------------------------------------------------ extrai.zip(chemin, nom, destination) : pas a pas
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

    public static synchronized String extraireDebut(String chemin, String nom, String destination, boolean ecra) {
        nettoyerExtraction();
        try {
            if (destination == null || destination.trim().isEmpty()) return "ERR:destination vide";
            File dest = new File(destination);
            if (dest.isDirectory()) return "ERR:'" + destination + "' est un dossier";
            if (!ecra && dest.exists()) return "ERR:le fichier existe deja : '" + destination + "' (utilise ecra~VRAI pour le remplacer)";
            File parent = dest.getAbsoluteFile().getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) return "ERR:impossible de creer le dossier '" + parent.getPath() + "'";
            Extraction e = new Extraction();
            e.l = creerLecteur(chemin, nom);            // lecteur DEDIE : le lecteur conserve de lire.zip n'est pas touche
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
