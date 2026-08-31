// Ce script s'execute APRES "npx cap add android" et "npx cap sync android" dans le
// workflow GitHub Actions. Capacitor regenere le dossier android/ a chaque fois, donc
// on ne peut pas modifier ces fichiers a la main une fois pour toutes : on les repatche
// a chaque build.
//
// 1) Ajoute a AndroidManifest.xml l'association des fichiers .mlg (pour que l'app
//    apparaisse dans "Ouvrir avec..." quand on tape sur un .mlg dans un gestionnaire
//    de fichiers / une piece jointe).
// 2) Remplace MainActivity.java par une version qui recupere le contenu du fichier
//    .mlg ouvert et le transmet a l'editeur web via window.chargerFichierExterne(texte).

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync('capacitor.config.json', 'utf8'));
const appId = config.appId;

/* ---------- 1) AndroidManifest.xml ---------- */
const manifestPath = path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');

// Permissions necessaires pour que MainActivity accede directement au stockage
// (listerDossier / ecrireFichier / lireFichier), sans passer par un selecteur systeme.
const permissionsStockage =
`    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
`;
if (!manifest.includes('MANAGE_EXTERNAL_STORAGE')) {
  manifest = manifest.replace('<application', permissionsStockage + '\n    <application');
  console.log('[patch-android] AndroidManifest.xml : permissions de stockage ajoutees.');
}

const intentFilterMlg =
`        <intent-filter>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="content" />
            <data android:scheme="file" />
            <data android:mimeType="*/*" />
            <data android:pathPattern=".*\\\\.mlg" />
        </intent-filter>
    </activity>`;

if (!manifest.includes('.mlg')) {
  manifest = manifest.replace('</activity>', intentFilterMlg);
  console.log('[patch-android] AndroidManifest.xml : association .mlg ajoutee.');
} else {
  console.log('[patch-android] AndroidManifest.xml : association .mlg deja presente.');
}
fs.writeFileSync(manifestPath, manifest);

/* ---------- 2) MainActivity.java ---------- */
const mainActivityDir = path.join('android', 'app', 'src', 'main', 'java', ...appId.split('.'));
const mainActivityPath = path.join(mainActivityDir, 'MainActivity.java');

const mainActivityContent = `package ${appId};

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

// Activite Android native de MonLangage.
// Fournit un pont JavaScript (window.MonLangage) qui donne un acces direct au
// stockage de l'appareil (pas de selecteur systeme Android) : l'editeur affiche
// son propre navigateur de dossiers, dans le style de l'app.
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(new MonLangageBridge(), "MonLangage");
        traiterIntentOuverture(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        traiterIntentOuverture(intent);
    }

    private class MonLangageBridge {

        // Chemin du dossier racine a partir duquel commence la navigation
        // (stockage partage de l'appareil).
        @JavascriptInterface
        public String dossierRacine() {
            return Environment.getExternalStorageDirectory().getAbsolutePath();
        }

        // VRAI si l'app a le droit d'acceder librement au stockage (Android 11+).
        @JavascriptInterface
        public boolean permissionStockageAccordee() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return Environment.isExternalStorageManager();
            }
            return true;
        }

        // Ouvre l'ecran systeme ou l'utilisateur accorde "l'acces a tous les fichiers"
        // a l'app (une seule fois necessaire). L'app doit ensuite rouvrir le
        // navigateur de fichiers elle-meme.
        @JavascriptInterface
        public void demanderPermissionStockage() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                }
            });
        }

        // Liste le contenu d'un dossier : [{"nom":"...", "dossier":true/false}, ...],
        // dossiers d'abord puis ordre alphabetique. [] si illisible/inexistant.
        @JavascriptInterface
        public String listerDossier(String chemin) {
            try {
                File dossier = new File(chemin);
                File[] elements = dossier.listFiles();
                JSONArray tableau = new JSONArray();
                if (elements != null) {
                    Arrays.sort(elements, (a, b) -> {
                        if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                        return a.getName().compareToIgnoreCase(b.getName());
                    });
                    for (File f : elements) {
                        if (f.isHidden()) continue;
                        JSONObject o = new JSONObject();
                        o.put("nom", f.getName());
                        o.put("dossier", f.isDirectory());
                        tableau.put(o);
                    }
                }
                return tableau.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        // Ecrit directement le contenu texte a l'emplacement demande (creation des
        // dossiers manquants si besoin). Renvoie VRAI en cas de succes.
        @JavascriptInterface
        public boolean ecrireFichier(String cheminComplet, String contenu) {
            try {
                File fichier = new File(cheminComplet);
                File parent = fichier.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                try (FileOutputStream sortie = new FileOutputStream(fichier)) {
                    sortie.write(contenu.getBytes(StandardCharsets.UTF_8));
                }
                return true;
            } catch (Exception e) {
                e.printStackTrace();
                return false;
            }
        }

        // Lit un fichier texte directement depuis le stockage. null si echec.
        @JavascriptInterface
        public String lireFichier(String cheminComplet) {
            try {
                StringBuilder contenu = new StringBuilder();
                try (BufferedReader lecteur = new BufferedReader(new InputStreamReader(
                        new FileInputStream(new File(cheminComplet)), StandardCharsets.UTF_8))) {
                    String ligne;
                    boolean premiere = true;
                    while ((ligne = lecteur.readLine()) != null) {
                        if (!premiere) contenu.append("\\n");
                        contenu.append(ligne);
                        premiere = false;
                    }
                }
                return contenu.toString();
            } catch (Exception e) {
                return null;
            }
        }
    }

    private void envoyerTexteAuWebView(String texte, String nom) {
        String texteEchappe = JSONObject.quote(texte);
        String nomEchappe = JSONObject.quote(nom);
        String js = "window.chargerFichierExterne && window.chargerFichierExterne(" + texteEchappe + ", " + nomEchappe + ");";

        // Le fichier peut etre choisi juste apres le demarrage de l'application.
        // post() attend que la WebView soit prete avant d'appeler JavaScript.
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    private String obtenirNomFichier(Uri uri) {
        String nom = null;
        try (android.database.Cursor cursor = getContentResolver().query(
                uri, new String[] { android.provider.OpenableColumns.DISPLAY_NAME },
                null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (index >= 0) nom = cursor.getString(index);
            }
        } catch (Exception ignored) { }
        if (nom == null || nom.trim().isEmpty()) {
            String dernier = uri.getLastPathSegment();
            nom = (dernier == null || dernier.trim().isEmpty()) ? "Sans fichier" : dernier;
        }
        return nom;
    }

    // Fichier .mlg ouvert depuis une autre appli (association .mlg / "Ouvrir avec...").
    private void traiterIntentOuverture(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;

        Uri uri = intent.getData();
        if (uri == null) return;

        try {
            StringBuilder contenu = new StringBuilder();

            try (BufferedReader lecteur = new BufferedReader(
                    new InputStreamReader(
                            getContentResolver().openInputStream(uri),
                            StandardCharsets.UTF_8))) {

                String ligne;
                boolean premiereLigne = true;
                while ((ligne = lecteur.readLine()) != null) {
                    if (!premiereLigne) contenu.append("\\n");
                    contenu.append(ligne);
                    premiereLigne = false;
                }
            }

            String texte = contenu.toString();

            // L'intent peut arriver avant la fin du chargement de index.html.
            // On attend un peu avant d'appeler chargerFichierExterne().
            getBridge().getWebView().postDelayed(
                () -> envoyerTexteAuWebView(texte, obtenirNomFichier(uri)),
                1200
            );

        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
`;

fs.mkdirSync(mainActivityDir, { recursive: true });
fs.writeFileSync(mainActivityPath, mainActivityContent);
console.log('[patch-android] MainActivity.java remplace.');
