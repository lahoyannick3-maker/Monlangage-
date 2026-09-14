// Ce script s'execute APRES "npx cap add android" et "npx cap sync android" dans le
// workflow GitHub Actions. Capacitor regenere le dossier android/ a chaque fois, donc
// on ne peut pas modifier ces fichiers a la main une fois pour toutes : on les repatche
// a chaque build.
//
// 1) Ajoute a AndroidManifest.xml l'association des fichiers .mlg (pour que l'app
//    apparaisse dans "Ouvrir avec..." quand on tape sur un .mlg dans un gestionnaire
//    de fichiers / une piece jointe), les permissions notifications/alarme exacte/boot,
//    et la declaration des deux BroadcastReceiver de planifier() (AlarmReceiver, BootReceiver).
// 2) Remplace MainActivity.java par une version qui recupere le contenu du fichier
//    .mlg ouvert et le transmet a l'editeur web via window.chargerFichierExterne(texte),
//    et qui expose planifier()/planifier.annuler() (alarmes systeme) au JS.
// 3) Ecrit AlarmScheduler.java / AlarmReceiver.java / BootReceiver.java (alarmes systeme
//    de planifier() : programmation, re-declenchement hebdomadaire, survie au redemarrage).

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

// Permissions necessaires pour planifier()/planifier.annuler() : alarmes systeme exactes
// (SCHEDULE_EXACT_ALARM pour Android 12-13, USE_EXACT_ALARM pour Android 13+, les deux sont
// sans risque a declarer ensemble), notifications (Android 13+ exige un accord explicite de
// l'utilisateur, demande a l'execution comme la permission stockage), et re-armement des
// alarmes apres un redemarrage du telephone (RECEIVE_BOOT_COMPLETED, cf BootReceiver.java).
const permissionsAlarmes =
`    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
    <uses-permission android:name="android.permission.USE_EXACT_ALARM" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
`;
if (!manifest.includes('SCHEDULE_EXACT_ALARM')) {
  manifest = manifest.replace('<application', permissionsAlarmes + '\n    <application');
  console.log('[patch-android] AndroidManifest.xml : permissions alarmes/notifications ajoutees.');
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

// Declaration des deux BroadcastReceiver de planifier() : AlarmReceiver (recoit le
// declenchement d'une alarme programmee, affiche la notification, se re-programme pour
// l'occurrence suivante) et BootReceiver (re-arme toutes les alarmes sauvegardees apres un
// redemarrage du telephone, car Android efface TOUTES les alarmes AlarmManager au reboot).
const receiversAlarmes =
`        <receiver android:name=".AlarmReceiver" android:exported="false" />
        <receiver android:name=".BootReceiver" android:exported="false">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
    </application>`;
if (!manifest.includes('.AlarmReceiver')) {
  manifest = manifest.replace('</application>', receiversAlarmes);
  console.log('[patch-android] AndroidManifest.xml : receivers AlarmReceiver/BootReceiver ajoutes.');
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

        // VRAI si l'app a le droit d'afficher des notifications (Android 13+ : accord
        // explicite requis ; avant : toujours autorise).
        @JavascriptInterface
        public boolean permissionNotificationsAccordee() {
            if (Build.VERSION.SDK_INT >= 33) {
                return checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
            }
            return true;
        }

        // Demande la permission de notification a l'utilisateur (boite de dialogue systeme,
        // Android 13+ uniquement -- ne fait rien avant).
        @JavascriptInterface
        public void demanderPermissionNotifications() {
            if (Build.VERSION.SDK_INT < 33) return;
            runOnUiThread(() ->
                requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 2001)
            );
        }

        // VRAI si l'app a le droit de programmer des alarmes EXACTES (Android 12+ : accord
        // requis, ecran systeme dedie ; avant : toujours autorise).
        @JavascriptInterface
        public boolean permissionAlarmeExacteAccordee() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                android.app.AlarmManager gestionnaireAlarmes =
                    (android.app.AlarmManager) getSystemService(ALARM_SERVICE);
                return gestionnaireAlarmes.canScheduleExactAlarms();
            }
            return true;
        }

        // Ouvre l'ecran systeme ou l'utilisateur autorise les alarmes exactes pour l'app
        // (Android 12+ uniquement -- ne fait rien avant).
        @JavascriptInterface
        public void demanderPermissionAlarmeExacte() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                    intent.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                } catch (Exception ignored) { }
            });
        }

        // planifier(jourSemaine, heure, minute, message) cote MonLangage : programme une
        // alarme systeme (AlarmManager) pour la PROCHAINE occurrence du jour/heure/minute
        // donnes (1=lundi..7=dimanche), qui affichera "message" en notification a ce moment-
        // la, meme si l'app est fermee. Se re-programme automatiquement chaque semaine
        // (AlarmReceiver) et survit a un redemarrage du telephone (BootReceiver). Appeler de
        // nouveau sur le meme jour/heure/minute remplace le message existant.
        @JavascriptInterface
        public void planifierAlarme(int jourSemaine, int heure, int minute, String message) {
            AlarmScheduler.programmer(MainActivity.this, jourSemaine, heure, minute, message);
        }

        // planifier.annuler(jourSemaine, heure, minute) cote MonLangage : annule une alarme
        // programmee par planifierAlarme(...) sur ce meme creneau.
        @JavascriptInterface
        public void annulerAlarme(int jourSemaine, int heure, int minute) {
            AlarmScheduler.annuler(MainActivity.this, jourSemaine, heure, minute);
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

        // VRAI si un fichier (pas un dossier) existe deja a cet emplacement. Utilise par
        // existe.fichier(...) et par ecrire.fichier(..., ecra~FAUX) pour eviter d'ecraser
        // un fichier existant sans que le codeur l'ait explicitement demande.
        @JavascriptInterface
        public boolean existeFichier(String cheminComplet) {
            try {
                File fichier = new File(cheminComplet);
                return fichier.exists() && fichier.isFile();
            } catch (Exception e) {
                return false;
            }
        }

        // Supprime un fichier (pas un dossier) a cet emplacement. Renvoie VRAI en cas de
        // succes (ou si le fichier n'existait deja pas). Utilise par supri.fichier(...).
        @JavascriptInterface
        public boolean supprimerFichier(String cheminComplet) {
            try {
                File fichier = new File(cheminComplet);
                if (!fichier.exists()) return true;
                if (fichier.isDirectory()) return false;
                return fichier.delete();
            } catch (Exception e) {
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

/* ---------- 3) AlarmScheduler.java / AlarmReceiver.java / BootReceiver.java ---------- */
// Ces 3 fichiers vont dans le meme dossier que MainActivity.java (meme package ${appId}).

const alarmSchedulerContent = `package ${appId};

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;

// Logique PARTAGEE de calcul/programmation des alarmes planifier(...), utilisee par
// MainActivity (MonLangageBridge, premiere programmation), AlarmReceiver (re-programmation
// pour la semaine suivante apres chaque declenchement) et BootReceiver (re-armement apres un
// redemarrage du telephone -- Android efface TOUTES les alarmes AlarmManager au reboot, donc
// rien ne se declencherait plus si on ne les reprogrammait pas nous-memes a chaque demarrage).
public class AlarmScheduler {
    public static final String PREFS_NAME = "monlangage_alarmes";

    // Meme calcul que secondesJusquaProchain(...) cote MonLangage (JS, index.html), en
    // millisecondes : delai avant la PROCHAINE occurrence du jour de semaine (1=lundi..
    // 7=dimanche, meme convention francaise/ISO des deux cotes) et de l'heure:minute donnes.
    // Si le moment cible est deja passe (ou en cours) aujourd'hui, bascule a la semaine
    // suivante -- jamais 0, jamais negatif.
    public static long calculerDelaiMs(int jourSemaine, int heure, int minute) {
        Calendar maintenant = Calendar.getInstance();
        Calendar cible = (Calendar) maintenant.clone();
        cible.set(Calendar.HOUR_OF_DAY, heure);
        cible.set(Calendar.MINUTE, minute);
        cible.set(Calendar.SECOND, 0);
        cible.set(Calendar.MILLISECOND, 0);

        // Calendar.DAY_OF_WEEK : SUNDAY=1..SATURDAY=7. Notre convention MonLangage est
        // 1=lundi..7=dimanche : on convertit avant de calculer l'ecart de jours.
        int jourActuelCal = maintenant.get(Calendar.DAY_OF_WEEK);
        int jourCibleCal = (jourSemaine % 7) + 1;

        int ecart = jourCibleCal - jourActuelCal;
        cible.add(Calendar.DAY_OF_MONTH, ecart);
        if (cible.getTimeInMillis() <= maintenant.getTimeInMillis()) {
            cible.add(Calendar.DAY_OF_MONTH, 7);
        }
        return cible.getTimeInMillis() - maintenant.getTimeInMillis();
    }

    // Identifiant stable pour un creneau (jourSemaine, heure, minute) : sert de requestCode
    // de PendingIntent ET de cle de sauvegarde -- planifier() une 2e fois sur le meme creneau
    // remplace le message existant plutot que d'empiler une 2e alarme independante.
    public static int idPour(int jourSemaine, int heure, int minute) {
        return jourSemaine * 10000 + heure * 100 + minute;
    }

    // Programme (ou re-programme) l'alarme pour la PROCHAINE occurrence, et sauvegarde le
    // creneau pour survivre a un redemarrage (BootReceiver).
    public static void programmer(Context context, int jourSemaine, int heure, int minute, String message) {
        long delaiMs = calculerDelaiMs(jourSemaine, heure, minute);
        int id = idPour(jourSemaine, heure, minute);
        programmerAvecDelai(context, id, jourSemaine, heure, minute, message, delaiMs);
        sauvegarder(context, jourSemaine, heure, minute, message);
    }

    static void programmerAvecDelai(Context context, int id, int jourSemaine, int heure, int minute, String message, long delaiMs) {
        Intent intent = new Intent(context, AlarmReceiver.class);
        intent.putExtra("id", id);
        intent.putExtra("jourSemaine", jourSemaine);
        intent.putExtra("heure", heure);
        intent.putExtra("minute", minute);
        intent.putExtra("message", message);
        PendingIntent pi = PendingIntent.getBroadcast(context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        AlarmManager gestionnaire = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        long declenchementMs = System.currentTimeMillis() + delaiMs;
        gestionnaire.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, declenchementMs, pi);
    }

    // Annule l'alarme d'un creneau et sa sauvegarde (plus reprogrammee apres reboot non plus).
    public static void annuler(Context context, int jourSemaine, int heure, int minute) {
        int id = idPour(jourSemaine, heure, minute);
        Intent intent = new Intent(context, AlarmReceiver.class);
        PendingIntent pi = PendingIntent.getBroadcast(context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        AlarmManager gestionnaire = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        gestionnaire.cancel(pi);
        pi.cancel();
        supprimerSauvegarde(context, jourSemaine, heure, minute);
    }

    private static void sauvegarder(Context context, int jourSemaine, int heure, int minute, String message) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String cle = jourSemaine + "_" + heure + "_" + minute;
        Set<String> cles = new HashSet<>(prefs.getStringSet("cles", new HashSet<>()));
        cles.add(cle);
        prefs.edit().putStringSet("cles", cles).putString("msg_" + cle, message).apply();
    }

    private static void supprimerSauvegarde(Context context, int jourSemaine, int heure, int minute) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String cle = jourSemaine + "_" + heure + "_" + minute;
        Set<String> cles = new HashSet<>(prefs.getStringSet("cles", new HashSet<>()));
        cles.remove(cle);
        prefs.edit().putStringSet("cles", cles).remove("msg_" + cle).apply();
    }

    // Re-arme TOUTES les alarmes sauvegardees (appele par BootReceiver juste apres un
    // redemarrage du telephone).
    public static void reprogrammerTout(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        Set<String> cles = prefs.getStringSet("cles", new HashSet<>());
        for (String cle : cles) {
            String[] parties = cle.split("_");
            if (parties.length != 3) continue;
            try {
                int jourSemaine = Integer.parseInt(parties[0]);
                int heure = Integer.parseInt(parties[1]);
                int minute = Integer.parseInt(parties[2]);
                String message = prefs.getString("msg_" + cle, "");
                long delaiMs = calculerDelaiMs(jourSemaine, heure, minute);
                int id = idPour(jourSemaine, heure, minute);
                programmerAvecDelai(context, id, jourSemaine, heure, minute, message, delaiMs);
            } catch (NumberFormatException ignoree) { }
        }
    }
}
`;

const alarmReceiverContent = `package ${appId};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

// Recoit le declenchement d'une alarme programmee par planifier(...) : affiche la
// notification, puis SE RE-PROGRAMME lui-meme pour l'occurrence suivante (les alarmes
// AlarmManager sont "one-shot" -- pas de recurrence "chaque lundi" native -- donc c'est ce
// re-declenchement manuel qui rend planifier() hebdomadaire).
public class AlarmReceiver extends BroadcastReceiver {
    public static final String CHANNEL_ID = "monlangage_planifier";

    @Override
    public void onReceive(Context context, Intent intent) {
        int jourSemaine = intent.getIntExtra("jourSemaine", 1);
        int heure = intent.getIntExtra("heure", 9);
        int minute = intent.getIntExtra("minute", 0);
        String message = intent.getStringExtra("message");
        if (message == null) message = "";
        int id = intent.getIntExtra("id", 0);

        afficherNotification(context, id, message);

        // Re-programme immediatement pour la PROCHAINE occurrence (dans 7 jours normalement,
        // puisqu'on vient tout juste de declencher celle d'aujourd'hui).
        AlarmScheduler.programmer(context, jourSemaine, heure, minute, message);
    }

    private void afficherNotification(Context context, int id, String message) {
        NotificationManager gestionnaire =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel canal = new NotificationChannel(
                CHANNEL_ID, "Rappels MonLangage", NotificationManager.IMPORTANCE_DEFAULT);
            gestionnaire.createNotificationChannel(canal);
        }

        Intent ouvrirApp = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent contenuIntent = null;
        if (ouvrirApp != null) {
            contenuIntent = PendingIntent.getActivity(context, id, ouvrirApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        Notification.Builder constructeur = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        constructeur.setContentTitle("MonLangage")
                    .setContentText(message)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setAutoCancel(true);
        if (contenuIntent != null) constructeur.setContentIntent(contenuIntent);

        gestionnaire.notify(id, constructeur.build());
    }
}
`;

const bootReceiverContent = `package ${appId};

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Android efface TOUTES les alarmes AlarmManager a chaque redemarrage du telephone : sans ce
// receiver, une alarme planifiee avec planifier() disparaitrait silencieusement au premier
// reboot. Reprogramme toutes les alarmes sauvegardees (AlarmScheduler.reprogrammerTout).
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            AlarmScheduler.reprogrammerTout(context);
        }
    }
}
`;

fs.writeFileSync(path.join(mainActivityDir, 'AlarmScheduler.java'), alarmSchedulerContent);
fs.writeFileSync(path.join(mainActivityDir, 'AlarmReceiver.java'), alarmReceiverContent);
fs.writeFileSync(path.join(mainActivityDir, 'BootReceiver.java'), bootReceiverContent);
console.log('[patch-android] AlarmScheduler.java / AlarmReceiver.java / BootReceiver.java ecrits.');

