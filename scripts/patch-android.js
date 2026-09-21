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

// Permissions necessaires a MonLangageService (execution en arriere-plan, meme app
// fermee -- cf commentaire complet au-dessus de la declaration <service> plus bas).
const permissionsServiceArrierePlan =
`    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
`;
if (!manifest.includes('FOREGROUND_SERVICE"')) {
  manifest = manifest.replace('<application', permissionsServiceArrierePlan + '\n    <application');
  console.log('[patch-android] AndroidManifest.xml : permissions service arriere-plan ajoutees.');
}

// PARTIAL_WAKE_LOCK : necessaire pendant l'execution d'un script pour que le CPU
// puisse continuer a executer la WebView meme lorsque l'ecran est eteint ou que
// Android entre en mode Doze. Le verrou n'est acquis que pendant un script actif
// et est relache des que le script termine/est arrete : le service reste donc
// "En veille" sans maintenir inutilement le CPU eveille.
const permissionWakeLock =
`    <uses-permission android:name="android.permission.WAKE_LOCK" />
`;
if (!manifest.includes('android.permission.WAKE_LOCK')) {
  manifest = manifest.replace('<application', permissionWakeLock + '\n    <application');
  console.log('[patch-android] AndroidManifest.xml : permission WAKE_LOCK ajoutee.');
}

// Permissions necessaires pour connexion.disponible()/connexion.type() (ACCESS_NETWORK_STATE,
// permission "normale" sans popup), batterie.niveau()/batterie.encharge() (aucune permission
// requise), et sms.recus()/sms.envoyer() (READ_SMS/SEND_SMS, permissions "dangereuses" :
// popup d'accord explicite demande a l'execution, meme mecanique que POST_NOTIFICATIONS).
const permissionsEtatAutomatisation =
`    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.READ_SMS" />
    <uses-permission android:name="android.permission.SEND_SMS" />
    <uses-permission android:name="android.permission.READ_PHONE_STATE" />
`;
if (!manifest.includes('ACCESS_NETWORK_STATE')) {
  manifest = manifest.replace('<application', permissionsEtatAutomatisation + '\n    <application');
  console.log('[patch-android] AndroidManifest.xml : permissions reseau/sms ajoutees.');
}

// Depuis Android 11 (API 30), un package ne "voit" plus les autres apps installees par
// defaut (visibilite des paquets) : PackageManager.getLaunchIntentForPackage("com.whatsapp")
// renvoie null MEME SI WhatsApp est installe, tant que le paquet n'est pas declare ici. Sans
// ca, whatsapp.ouvrir() bascule TOUJOURS sur le repli web (https://www.whatsapp.com/) au lieu
// d'ouvrir l'app. On declare WhatsApp classique + WhatsApp Business.
const queriesWhatsapp =
`    <queries>
        <package android:name="com.whatsapp" />
        <package android:name="com.whatsapp.w4b" />
    </queries>
`;
if (!manifest.includes('<queries>')) {
  manifest = manifest.replace('<application', queriesWhatsapp + '\n    <application');
  console.log('[patch-android] AndroidManifest.xml : bloc <queries> ajoute (visibilite WhatsApp).');
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

// MonLangageService : service premier-plan (notification permanente obligatoire des
// Android 8+, comme celle de Termux) qui heberge sa propre WebView headless (jamais
// affichee) chargeant www/index.html, pour executer un script MonLangage independamment
// de MainActivity -- il continue de tourner meme apres fermeture de l'app. Declare
// exported="true" : n'importe quelle app externe (ou un "am startservice" en shell)
// peut lui envoyer une commande ou l'arreter, sur le meme principe que RUN_COMMAND de
// Termux. android:process n'est PAS precise : le service tourne dans le meme processus
// que l'app (obligatoire ici, une WebView Android ne peut etre pilotee que depuis le
// thread principal du processus qui l'a creee).
const serviceArrierePlan =
`        <service
            android:name=".MonLangageService"
            android:exported="true"
            android:foregroundServiceType="dataSync" />
    </application>`;
if (!manifest.includes('.MonLangageService')) {
  manifest = manifest.replace('</application>', serviceArrierePlan);
  console.log('[patch-android] AndroidManifest.xml : service MonLangageService declare.');
}

// FileProvider : necessaire pour partager.fichier() -- Android interdit de partager un
// chemin de fichier direct (file://) avec une autre application depuis Android 7 ; il faut
// passer par un FileProvider qui genere une URI temporaire (content://) avec permission de
// lecture accordee juste a l'app destinataire du partage.
const authoriteFileProvider = appId + '.fileprovider';
const providerFileProvider =
`        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${authoriteFileProvider}"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>
    </application>`;
if (!manifest.includes('FileProvider')) {
  manifest = manifest.replace('</application>', providerFileProvider);
  console.log('[patch-android] AndroidManifest.xml : FileProvider ajoute (partager.fichier()).');
}

fs.writeFileSync(manifestPath, manifest);

/* ---------- res/xml/file_paths.xml (chemins autorises pour le FileProvider) ---------- */
const filePathsDir = path.join('android', 'app', 'src', 'main', 'res', 'xml');
if (!fs.existsSync(filePathsDir)) fs.mkdirSync(filePathsDir, { recursive: true });
const filePathsPath = path.join(filePathsDir, 'file_paths.xml');
const filePathsContent = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <external-path name="stockage_externe" path="." />
</paths>
`;
fs.writeFileSync(filePathsPath, filePathsContent);
console.log('[patch-android] res/xml/file_paths.xml : ecrit (partager.fichier()).');

/* ---------- 2) MonLangageBridge.java : implementation native partagee ---------- */
const bridgeDir = path.join('android', 'app', 'src', 'main', 'java', ...appId.split('.'));
fs.mkdirSync(bridgeDir, { recursive: true });
const monLangageBridgeContent = `package ${appId};

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.lang.ref.WeakReference;

// Implementation native UNIQUE partagee entre MainActivity et MonLangageService.
// activity peut etre null lorsque le bridge est utilise par la WebView headless du service.
public class MonLangageBridge {
    // Activity principale actuellement visible. Le service peut ainsi remettre une
    // commande UI a l'editeur lorsqu'il est au premier plan, sans tenter de lancer
    // une Activity depuis un contexte d'arriere-plan. WeakReference evite de retenir
    // l'Activity apres sa destruction.
    private static WeakReference<Activity> activitePrincipale = new WeakReference<>(null);

    public static void definirActivitePrincipale(Activity activity) {
        activitePrincipale = new WeakReference<>(activity);
    }

    public static void effacerActivitePrincipale(Activity activity) {
        Activity actuelle = activitePrincipale.get();
        if (actuelle == activity) activitePrincipale = new WeakReference<>(null);
    }

    protected final Context context;
    protected final Activity activity;

    public MonLangageBridge(Context context, Activity activity) {
        this.context = context.getApplicationContext();
        this.activity = activity;
    }

    private void runOnUiThread(Runnable action) {
        if (activity != null) activity.runOnUiThread(action);
        else new android.os.Handler(android.os.Looper.getMainLooper()).post(action);
    }

    private boolean ouvrirActiviteOuNotification(Intent intent, String titre) {
        // Cas 1 : bridge directement rattache a MainActivity.
        if (activity != null) {
            activity.runOnUiThread(() -> {
                try {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(intent);
                } catch (Exception ignored) {
                    publierNotificationAction(intent, titre);
                }
            });
            return true;
        }

        // Cas 2 : le script tourne dans la WebView headless du service, mais l'editeur
        // MonLangage est actuellement visible. On utilise l'Activity deja au premier
        // plan afin que whatsapp.ouvrir() appele par RUN puisse ouvrir WhatsApp.
        Activity activiteVisible = activitePrincipale.get();
        if (activiteVisible != null) {
            activiteVisible.runOnUiThread(() -> {
                try {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activiteVisible.startActivity(intent);
                } catch (Exception ignored) {
                    publierNotificationAction(intent, titre);
                }
            });
            return true;
        }

        // Cas 3 : aucune interface disponible. Repli non bloquant par notification.
        publierNotificationAction(intent, titre);
        return true;
    }

    private void publierNotificationAction(Intent intent, String titre) {
        try {
            int id = (int) (System.currentTimeMillis() & 0x7fffffff);
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            final String canalId = "monlangage_actions";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(new NotificationChannel(canalId, "Actions MonLangage", NotificationManager.IMPORTANCE_HIGH));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(context, id, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, canalId) : new Notification.Builder(context);
            b.setContentTitle("MonLangage")
             .setContentText(titre + " — appuyez pour continuer")
             .setSmallIcon(android.R.drawable.ic_dialog_info)
             .setContentIntent(pi)
             .setAutoCancel(true);
            nm.notify(id, b.build());
        } catch (Exception ignored) {
            // Une commande UI ne doit jamais bloquer l'execution du script MLG.
        }
    }


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
            if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.setData(Uri.parse("package:" + context.getPackageName()));
                    activity.startActivity(intent);
                } catch (Exception e) {
                    activity.startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                }
            });
        }

        // VRAI si l'app a le droit d'afficher des notifications (Android 13+ : accord
        // explicite requis ; avant : toujours autorise).
        @JavascriptInterface
        public boolean permissionNotificationsAccordee() {
            if (Build.VERSION.SDK_INT >= 33) {
                return context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
            }
            return true;
        }

        // Demande la permission de notification a l'utilisateur (boite de dialogue systeme,
        // Android 13+ uniquement -- ne fait rien avant).
        @JavascriptInterface
        public void demanderPermissionNotifications() {
            if (activity == null || Build.VERSION.SDK_INT < 33) return;
            runOnUiThread(() ->
                activity.requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 2001)
            );
        }

        // notif.envoyer(message) cote MonLangage : affiche immediatement une notification
        // systeme Android. Renvoie VRAI si Android accepte la notification, FAUX en cas
        // d'erreur. Le clic sur la notification rouvre l'application MonLangage.
        @JavascriptInterface
        public boolean envoyerNotification(String message) {
            try {
                android.app.NotificationManager gestionnaire =
                    (android.app.NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (gestionnaire == null) return false;

                final String canalId = "monlangage_notif";
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    android.app.NotificationChannel canal = new android.app.NotificationChannel(
                        canalId, "Notifications MonLangage", android.app.NotificationManager.IMPORTANCE_DEFAULT);
                    gestionnaire.createNotificationChannel(canal);
                }

                int id = (int) (System.currentTimeMillis() & 0x7fffffff);
                Intent ouvrirApp = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
                android.app.PendingIntent contenuIntent = null;
                if (ouvrirApp != null) {
                    contenuIntent = android.app.PendingIntent.getActivity(
                        context, id, ouvrirApp,
                        android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
                }

                android.app.Notification.Builder constructeur = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    ? new android.app.Notification.Builder(context, canalId)
                    : new android.app.Notification.Builder(context);
                constructeur.setContentTitle("MonLangage")
                            .setContentText(message)
                            .setSmallIcon(android.R.drawable.ic_dialog_info)
                            .setAutoCancel(true);
                if (contenuIntent != null) constructeur.setContentIntent(contenuIntent);

                gestionnaire.notify(id, constructeur.build());
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        // VRAI si l'app a le droit de programmer des alarmes EXACTES (Android 12+ : accord
        // requis, ecran systeme dedie ; avant : toujours autorise).
        @JavascriptInterface
        public boolean permissionAlarmeExacteAccordee() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                android.app.AlarmManager gestionnaireAlarmes =
                    (android.app.AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
                return gestionnaireAlarmes.canScheduleExactAlarms();
            }
            return true;
        }

        // Ouvre l'ecran systeme ou l'utilisateur autorise les alarmes exactes pour l'app
        // (Android 12+ uniquement -- ne fait rien avant).
        @JavascriptInterface
        public void demanderPermissionAlarmeExacte() {
            if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                    intent.setData(Uri.parse("package:" + context.getPackageName()));
                    activity.startActivity(intent);
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
            AlarmScheduler.programmer(context, jourSemaine, heure, minute, message);
        }

        // planifier.annuler(jourSemaine, heure, minute) cote MonLangage : annule une alarme
        // programmee par planifierAlarme(...) sur ce meme creneau. Renvoie VRAI si un creneau
        // etait effectivement programme (et a donc ete annule), FAUX sinon.
        @JavascriptInterface
        public boolean annulerAlarme(int jourSemaine, int heure, int minute) {
            return AlarmScheduler.annuler(context, jourSemaine, heure, minute);
        }

        // planifier.liste() cote MonLangage : liste toutes les alarmes actuellement
        // programmees, en JSON.
        @JavascriptInterface
        public String listerAlarmes() {
            return AlarmScheduler.listerJson(context);
        }

        // connexion.disponible() cote MonLangage : VRAI si une connexion internet (wifi ou
        // data mobile) est active ET validee (verifie un vrai acces internet, pas juste
        // "associe a un reseau"). Ne necessite aucune permission a l'execution
        // (ACCESS_NETWORK_STATE est une permission "normale", accordee automatiquement).
        @JavascriptInterface
        public boolean connexionDisponible() {
            android.net.ConnectivityManager gestionnaireReseau =
                (android.net.ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (gestionnaireReseau == null) return false;
            android.net.Network reseauActif = gestionnaireReseau.getActiveNetwork();
            if (reseauActif == null) return false;
            android.net.NetworkCapabilities capacites = gestionnaireReseau.getNetworkCapabilities(reseauActif);
            return capacites != null
                && capacites.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && capacites.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        }

        // connexion.type() cote MonLangage : "wifi", "mobile", "ethernet", "autre" ou
        // "aucune".
        @JavascriptInterface
        public String connexionType() {
            android.net.ConnectivityManager gestionnaireReseau =
                (android.net.ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (gestionnaireReseau == null) return "aucune";
            android.net.Network reseauActif = gestionnaireReseau.getActiveNetwork();
            if (reseauActif == null) return "aucune";
            android.net.NetworkCapabilities capacites = gestionnaireReseau.getNetworkCapabilities(reseauActif);
            if (capacites == null) return "aucune";
            if (capacites.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
            if (capacites.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) return "mobile";
            if (capacites.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
            return "autre";
        }

        // batterie.niveau() cote MonLangage : pourcentage de batterie restant (0-100).
        // Aucune permission requise.
        @JavascriptInterface
        public int batterieNiveau() {
            android.os.BatteryManager gestionnaireBatterie =
                (android.os.BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
            if (gestionnaireBatterie == null) return -1;
            return gestionnaireBatterie.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY);
        }

        // batterie.encharge() cote MonLangage : VRAI si le telephone est en train de charger
        // (cable ou sans fil) ou deja completement charge. Aucune permission requise.
        @JavascriptInterface
        public boolean batterieEnCharge() {
            android.content.IntentFilter filtre = new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED);
            Intent etatBatterie = context.registerReceiver(null, filtre);
            if (etatBatterie == null) return false;
            int statut = etatBatterie.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1);
            return statut == android.os.BatteryManager.BATTERY_STATUS_CHARGING
                || statut == android.os.BatteryManager.BATTERY_STATUS_FULL;
        }

        // VRAI si l'app a le droit de lire les SMS recus (Android : accord explicite
        // requis, popup systeme).
        @JavascriptInterface
        public boolean permissionSmsLectureAccordee() {
            return context.checkSelfPermission(android.Manifest.permission.READ_SMS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }

        // Demande la permission de lecture des SMS a l'utilisateur (boite de dialogue
        // systeme).
        @JavascriptInterface
        public void demanderPermissionSmsLecture() {
            if (activity == null) return;
            runOnUiThread(() ->
                activity.requestPermissions(new String[] { android.Manifest.permission.READ_SMS }, 2002)
            );
        }

        // VRAI si l'app a le droit d'envoyer des SMS (accord explicite requis, popup
        // systeme).
        @JavascriptInterface
        public boolean permissionSmsEnvoiAccordee() {
            return context.checkSelfPermission(android.Manifest.permission.SEND_SMS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }

        // Demande la permission d'envoi de SMS a l'utilisateur (boite de dialogue systeme).
        @JavascriptInterface
        public void demanderPermissionSmsEnvoi() {
            if (activity == null) return;
            runOnUiThread(() ->
                activity.requestPermissions(new String[] { android.Manifest.permission.SEND_SMS }, 2003)
            );
        }

        // sms.recus(depuisSecondes) cote MonLangage : SMS recus dans la boite de reception
        // au cours des "depuisSecondes" dernieres secondes, en JSON :
        // [{"numero":"...","message":"...","date":epochMillis}, ...], plus recent en premier.
        // "[]" si aucun ou en cas d'erreur (permission refusee entre-temps, par exemple).
        @JavascriptInterface
        public String smsRecus(long depuisSecondes) {
            long seuil = System.currentTimeMillis() - (depuisSecondes * 1000L);
            JSONArray tableau = new JSONArray();
            android.net.Uri uriBoite = android.provider.Telephony.Sms.Inbox.CONTENT_URI;
            String[] colonnes = {
                android.provider.Telephony.Sms.ADDRESS,
                android.provider.Telephony.Sms.BODY,
                android.provider.Telephony.Sms.DATE
            };
            String selection = android.provider.Telephony.Sms.DATE + " >= ?";
            String[] argsSelection = { String.valueOf(seuil) };
            String tri = android.provider.Telephony.Sms.DATE + " DESC";
            try (android.database.Cursor curseur = context.getContentResolver().query(
                    uriBoite, colonnes, selection, argsSelection, tri)) {
                if (curseur != null) {
                    int iAdresse = curseur.getColumnIndex(android.provider.Telephony.Sms.ADDRESS);
                    int iCorps = curseur.getColumnIndex(android.provider.Telephony.Sms.BODY);
                    int iDate = curseur.getColumnIndex(android.provider.Telephony.Sms.DATE);
                    while (curseur.moveToNext()) {
                        try {
                            JSONObject o = new JSONObject();
                            o.put("numero", curseur.getString(iAdresse));
                            o.put("message", curseur.getString(iCorps));
                            o.put("date", curseur.getLong(iDate));
                            tableau.put(o);
                        } catch (Exception ignoree) { }
                    }
                }
            } catch (Exception e) {
                return "[]";
            }
            return tableau.toString();
        }

        // VRAI si l'app a le droit de lire l'etat du telephone (necessaire uniquement pour
        // choisir explicitement une SIM avec sms.envoyer(numero, message, sim)).
        @JavascriptInterface
        public boolean permissionTelephoneAccordee() {
            return context.checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }

        // Demande la permission de lecture d'etat telephone (boite de dialogue systeme).
        @JavascriptInterface
        public void demanderPermissionTelephone() {
            if (activity == null) return;
            runOnUiThread(() ->
                activity.requestPermissions(new String[] { android.Manifest.permission.READ_PHONE_STATE }, 2004)
            );
        }

        // sms.envoyer(numero, message, sim) cote MonLangage : envoie un SMS et attend la
        // confirmation REELLE d'envoi (broadcast systeme SMS_SENT, pas seulement le fait
        // qu'Android ait accepte la demande). Renvoie VRAI seulement si CHAQUE partie du
        // message (les messages longs sont decoupes en plusieurs parties SMS, reassemblees
        // en un seul message chez le destinataire) a ete confirmee envoyee par le systeme.
        // Attend au maximum 15 secondes ; au-dela, considere l'envoi comme un echec (reseau
        // injoignable, par exemple).
        @JavascriptInterface
        public boolean envoyerSms(String numero, String message, int sim) {
            BroadcastReceiver recepteur = null;
            try {
                android.telephony.SmsManager gestionnaireSms;
                if (sim == 1 || sim == 2) {
                    if (!permissionTelephoneAccordee()) return false;
                    android.telephony.SubscriptionManager subscriptions =
                        (android.telephony.SubscriptionManager) context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
                    if (subscriptions == null) return false;
                    android.telephony.SubscriptionInfo info =
                        subscriptions.getActiveSubscriptionInfoForSimSlotIndex(sim - 1);
                    if (info == null) return false;
                    gestionnaireSms = android.telephony.SmsManager.getSmsManagerForSubscriptionId(info.getSubscriptionId());
                } else {
                    gestionnaireSms = android.telephony.SmsManager.getDefault();
                }

                ArrayList<String> parties = gestionnaireSms.divideMessage(message);
                int nbParties = Math.max(parties.size(), 1);
                String action = "${appId}.SMS_ENVOYE_" + System.nanoTime();

                CountDownLatch verrou = new CountDownLatch(nbParties);
                AtomicInteger echecs = new AtomicInteger(0);
                recepteur = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        if (getResultCode() != Activity.RESULT_OK) echecs.incrementAndGet();
                        verrou.countDown();
                    }
                };
                if (Build.VERSION.SDK_INT >= 33) {
                    // Le broadcast SMS_SENT est emis par le processus telephonie systeme (pas
                    // par MonLangage lui-meme) : RECEIVER_NOT_EXPORTED le bloquerait (l'appel
                    // repond alors toujours FAUX apres le delai de 15s, meme si le SMS est
                    // reellement parti chez le destinataire). Il faut RECEIVER_EXPORTED ici.
                    context.registerReceiver(recepteur, new IntentFilter(action), Context.RECEIVER_EXPORTED);
                } else {
                    context.registerReceiver(recepteur, new IntentFilter(action));
                }

                if (parties.size() > 1) {
                    ArrayList<PendingIntent> intentsEnvoi = new ArrayList<>();
                    for (int i = 0; i < parties.size(); i++) {
                        intentsEnvoi.add(PendingIntent.getBroadcast(context, i,
                            new Intent(action), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
                    }
                    gestionnaireSms.sendMultipartTextMessage(numero, null, parties, intentsEnvoi, null);
                } else {
                    PendingIntent intentEnvoi = PendingIntent.getBroadcast(context, 0,
                        new Intent(action), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    gestionnaireSms.sendTextMessage(numero, null, message, intentEnvoi, null);
                }

                boolean toutRecu = verrou.await(15, TimeUnit.SECONDS);
                return toutRecu && echecs.get() == 0;
            } catch (Exception e) {
                return false;
            } finally {
                if (recepteur != null) {
                    try { context.unregisterReceiver(recepteur); } catch (Exception ignoree) { }
                }
            }
        }

        // whatsapp.ouvrir(numero, message) cote MonLangage : ouvre WhatsApp (ou le
        // navigateur si l'app n'est pas installee) sur la conversation avec ce numero, texte
        // deja rempli dans le champ de saisie -- l'utilisateur doit lui-meme appuyer sur
        // Envoyer, Android n'autorise pas une app tierce a envoyer un message a la place de
        // l'utilisateur dans une autre app. numero : n'importe quel format, les caracteres
        // non numeriques (espaces, +, tirets) sont retires automatiquement -- garder
        // l'indicatif pays (ex: 33612345678 pour la France, sans le 0 initial).
        @JavascriptInterface
        public void ouvrirWhatsapp() {
            Intent intent = context.getPackageManager().getLaunchIntentForPackage("com.whatsapp");
            if (intent == null) {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://www.whatsapp.com/"));
            }
            ouvrirActiviteOuNotification(intent, "Ouvrir WhatsApp");
        }

        @JavascriptInterface
        public void ouvrirWhatsapp(String numero, String message) {
            String numeroPropre = numero.replaceAll("[^0-9]", "");
            String url = "https://wa.me/" + numeroPropre + "?text=" + Uri.encode(message);
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            ouvrirActiviteOuNotification(intent, "Ouvrir WhatsApp");
        }

        // messenger.ouvrir(destinataire, message) cote MonLangage : meme principe que
        // whatsapp.ouvrir(...), mais pour Messenger (Facebook). ATTENTION : destinataire est
        // un NOM D'UTILISATEUR Facebook (pas un numero de telephone -- Messenger n'identifie
        // pas les gens par numero comme WhatsApp).
        @JavascriptInterface
        public void ouvrirMessenger(String destinataire, String message) {
            String url = "https://m.me/" + Uri.encode(destinataire) + "?text=" + Uri.encode(message);
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            ouvrirActiviteOuNotification(intent, "Ouvrir Messenger");
        }

        // partager.fichier(chemin) cote MonLangage : ouvre le selecteur de partage standard
        // Android (Bluetooth, email, Drive, n'importe quelle app acceptant un fichier -- PAS
        // specifique a une messagerie) pour ce fichier. Renvoie FAUX si le fichier n'existe
        // pas (rien n'est ouvert dans ce cas), VRAI si le selecteur a ete ouvert (n'indique
        // pas que le partage a ete complete, juste que le selecteur s'est ouvert).
        @JavascriptInterface
        public boolean partagerFichier(String cheminComplet) {
            try {
                File fichier = new File(cheminComplet);
                if (!fichier.exists() || !fichier.isFile()) return false;
                android.net.Uri uriFichier = FileProvider.getUriForFile(
                    context, context.getPackageName() + ".fileprovider", fichier);
                String type = context.getContentResolver().getType(uriFichier);
                if (type == null) {
                    String extension = MimeTypeMap.getFileExtensionFromUrl(fichier.getAbsolutePath());
                    type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                }
                if (type == null) type = "*/*";
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType(type);
                intent.putExtra(Intent.EXTRA_STREAM, uriFichier);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                ouvrirActiviteOuNotification(Intent.createChooser(intent, null), "Partager le fichier");
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        // taille.fichier(chemin) cote MonLangage : taille du fichier en OCTETS. -1 si le
        // fichier n'existe pas.
        @JavascriptInterface
        public long tailleFichier(String cheminComplet) {
            try {
                File fichier = new File(cheminComplet);
                if (!fichier.exists() || !fichier.isFile()) return -1;
                return fichier.length();
            } catch (Exception e) {
                return -1;
            }
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
`;
fs.writeFileSync(path.join(bridgeDir, 'MonLangageBridge.java'), monLangageBridgeContent);
console.log('[patch-android] MonLangageBridge.java ecrit (implementation native partagee).');

/* ---------- 2) MainActivity.java ---------- */
const mainActivityDir = path.join('android', 'app', 'src', 'main', 'java', ...appId.split('.'));
const mainActivityPath = path.join(mainActivityDir, 'MainActivity.java');

const mainActivityContent = `package ${appId};

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

// Activite Android native de MonLangage.
// Fournit un pont JavaScript (window.MonLangage) qui donne un acces direct au
// stockage de l'appareil (pas de selecteur systeme Android) : l'editeur affiche
// son propre navigateur de dossiers, dans le style de l'app.
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(new MainActivityBridge(), "MonLangage");
        // Le service est une infrastructure de l'application : il demarre automatiquement
        // a l'ouverture de MonLangage. Aucune commande MLG n'est necessaire pour l'activer.
        Intent serviceIntent = new Intent(MainActivity.this, MonLangageService.class);
        serviceIntent.setAction(MonLangageService.ACTION_START);
        androidx.core.content.ContextCompat.startForegroundService(MainActivity.this, serviceIntent);
        MonLangageBridge.definirActivitePrincipale(MainActivity.this);
        traiterIntentOuverture(getIntent());
    }

    @Override
    public void onResume() {
        super.onResume();
        MonLangageBridge.definirActivitePrincipale(MainActivity.this);
    }

    @Override
    public void onStop() {
        MonLangageBridge.effacerActivitePrincipale(MainActivity.this);
        super.onStop();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        traiterIntentOuverture(intent);
    }

    private class MainActivityBridge extends MonLangageBridge {
        MainActivityBridge() { super(MainActivity.this, MainActivity.this); }

        // service.demarrer() cote MonLangage : demarre MonLangageService (notification
        // persistante "MonLangage actif" + bouton Arreter, comme Termux). Sans effet si
        // deja demarre.
        @JavascriptInterface
        public void demarrerServiceArrierePlan() {
            Intent intent = new Intent(MainActivity.this, MonLangageService.class);
            intent.setAction(MonLangageService.ACTION_START);
            androidx.core.content.ContextCompat.startForegroundService(MainActivity.this, intent);
        }

        // service.executer(script) cote MonLangage : envoie un script a executer par
        // MonLangageService. Demarre le service automatiquement s'il n'est pas deja actif.
        // Chaque appel est une execution independante (pas d'etat partage entre deux
        // scripts envoyes au service -- voir commentaire dans MonLangageService.java).
        @JavascriptInterface
        public void envoyerScriptService(String script) {
            Intent intent = new Intent(MainActivity.this, MonLangageService.class);
            intent.setAction(MonLangageService.ACTION_RUN);
            intent.putExtra(MonLangageService.EXTRA_SCRIPT, script);
            androidx.core.content.ContextCompat.startForegroundService(MainActivity.this, intent);
        }

        @JavascriptInterface
        public boolean serviceScriptEnCours() {
            return getSharedPreferences("monlangage_service_prefs", MODE_PRIVATE)
                .getBoolean("script_actif", false);
        }

        @JavascriptInterface
        public int dernierResultatServiceId() {
            return getSharedPreferences("monlangage_service_prefs", MODE_PRIVATE)
                .getInt("dernier_id", 0);
        }

        @JavascriptInterface
        public String dernierResultatService() {
            return getSharedPreferences("monlangage_service_prefs", MODE_PRIVATE)
                .getString("dernier_resultat", "");
        }

        // Arret d'urgence du SCRIPT uniquement. Le service foreground reste actif.
        @JavascriptInterface
        public void arreterScriptService() {
            Intent intent = new Intent(MainActivity.this, MonLangageService.class);
            intent.setAction(MonLangageService.ACTION_CANCEL_SCRIPT);
            startService(intent);
        }

        // service.arreter() cote MonLangage : arrete MonLangageService (equivalent du
        // bouton "Arreter" de la notification).
        @JavascriptInterface
        public void arreterServiceArrierePlan() {
            Intent intent = new Intent(MainActivity.this, MonLangageService.class);
            intent.setAction(MonLangageService.ACTION_STOP);
            startService(intent);
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
import org.json.JSONArray;
import org.json.JSONObject;
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
    // Renvoie VRAI si un creneau etait effectivement programme (et a donc ete annule), FAUX
    // si on appelle annuler(...) sur un creneau qui n'existait pas -- AlarmManager.cancel(...)
    // ne signale jamais lui-meme si l'alarme existait vraiment, d'ou cette verification
    // prealable dans notre propre sauvegarde (meme source de verite que listerJson/
    // reprogrammerTout).
    public static boolean annuler(Context context, int jourSemaine, int heure, int minute) {
        String cle = jourSemaine + "_" + heure + "_" + minute;
        SharedPreferences prefsCheck = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        boolean existait = prefsCheck.getStringSet("cles", new HashSet<>()).contains(cle);

        int id = idPour(jourSemaine, heure, minute);
        Intent intent = new Intent(context, AlarmReceiver.class);
        PendingIntent pi = PendingIntent.getBroadcast(context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        AlarmManager gestionnaire = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        gestionnaire.cancel(pi);
        pi.cancel();
        supprimerSauvegarde(context, jourSemaine, heure, minute);
        return existait;
    }

    // Liste toutes les alarmes actuellement programmees et sauvegardees, en JSON :
    // [{"jourSemaine":1,"heure":7,"minute":30,"message":"..."}, ...]. "[]" si aucune.
    public static String listerJson(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        Set<String> cles = prefs.getStringSet("cles", new HashSet<>());
        JSONArray tableau = new JSONArray();
        for (String cle : cles) {
            String[] parties = cle.split("_");
            if (parties.length != 3) continue;
            try {
                int jourSemaine = Integer.parseInt(parties[0]);
                int heure = Integer.parseInt(parties[1]);
                int minute = Integer.parseInt(parties[2]);
                String message = prefs.getString("msg_" + cle, "");
                JSONObject o = new JSONObject();
                o.put("jourSemaine", jourSemaine);
                o.put("heure", heure);
                o.put("minute", minute);
                o.put("message", message);
                tableau.put(o);
            } catch (Exception ignoree) { }
        }
        return tableau.toString();
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
import android.content.IntentFilter;

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

/* ---------- MonLangageService.java : execution en arriere-plan ---------- */
// Service premier-plan qui heberge sa PROPRE WebView, creee par code et jamais
// attachee a un ecran (headless) -- distincte de celle de MainActivity. Elle charge
// le meme www/index.html (donc le meme interpreteur MonLangage complet, avec les
// memes fonctions globales dont executerScriptExterne(), ajoutee cote index.html).
// Comme cette WebView n'est liee a aucune Activity, elle survit a la fermeture de
// l'interface : tant que le Service est en vie (notification premiere-plan obligatoire
// depuis Android 8+, comme celle de Termux), un script en cours continue de tourner.
//
// Choix retenu (Option "2a") : chaque script envoye via ACTION_RUN est une execution
// INDEPENDANTE. executerScriptLocal() (dans index.html) reinitialise scopes/fonctions/modules a
// chaque appel -- donc deux scripts envoyes au service ne partagent PAS leurs
// variables/fonctions entre eux, exactement comme s'ils avaient ete lances separement
// depuis l'editeur. Un seul script peut neanmoins contenir une boucle infinie ou un
// traitement long : il continue de tourner en arriere-plan jusqu'a sa fin ou jusqu'a
// l'arret du service. Pendant cette execution, un PARTIAL_WAKE_LOCK est tenu par le
// service afin que les timers JavaScript de fonctions comme attendre() continuent a
// progresser meme ecran eteint / en mode Doze. Le verrou est libere des la fin du script.
//
// exported="true" sur la declaration <service> (AndroidManifest.xml) : n'importe
// quelle app externe, ou un "adb shell am start-service" / "am start-service" depuis
// un terminal (Termux y compris), peut envoyer une commande ou arreter le service --
// meme principe que RUN_COMMAND de Termux. Exemple d'appel externe :
//   am start-service -n ${appId}/.MonLangageService \\
//       -a ${appId}.action.RUN --es script "afficher('salut')"
//   am start-service -n ${appId}/.MonLangageService -a ${appId}.action.STOP
const monLangageServiceContent = `package ${appId};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.ArrayDeque;
import java.util.Deque;
import org.json.JSONObject;

public class MonLangageService extends Service {

    public static final String ACTION_START = "${appId}.action.START";
    public static final String ACTION_RUN   = "${appId}.action.RUN";
    public static final String ACTION_CANCEL_SCRIPT = "${appId}.action.CANCEL_SCRIPT";
    public static final String ACTION_STOP  = "${appId}.action.STOP";
    public static final String EXTRA_SCRIPT = "script";

    private static final String CHANNEL_ID = "monlangage_service";
    private static final int NOTIF_ID_SERVICE = 9001;
    private static final String PREFS_NAME = "monlangage_service_prefs";

    private WebView webView;
    private boolean webViewPrete = false;
    private boolean scriptActif = false;
    private int compteurExecutions = 0;
    // Pose par arreter.service.arriere() cote MLG lorsqu'un script demande l'arret du
    // service. Lu UNE SEULE FOIS, a la toute fin naturelle du script qui l'a demande
    // (dans terminerScript ci-dessous) : si le script plante avant d'atteindre cette
    // commande, le drapeau n'est jamais pose et le service reste actif comme avant.
    private volatile boolean arretApresScriptDemande = false;

    // Garde le CPU eveille pendant un script actif, y compris pendant attendre(...).
    // Un foreground service seul ne garantit pas que les timers JavaScript continuent
    // normalement lorsque l'ecran est eteint / que Doze suspend le CPU.
    private PowerManager.WakeLock wakeLockScript;

    private void acquerirWakeLockScript() {
        if (wakeLockScript != null && wakeLockScript.isHeld()) return;
        PowerManager gestionnaire = (PowerManager) getSystemService(POWER_SERVICE);
        if (gestionnaire == null) return;
        wakeLockScript = gestionnaire.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            getPackageName() + ":MonLangageScript"
        );
        wakeLockScript.setReferenceCounted(false);
        wakeLockScript.acquire();
    }

    private void libererWakeLockScript() {
        if (wakeLockScript != null && wakeLockScript.isHeld()) {
            try { wakeLockScript.release(); } catch (Exception ignored) {}
        }
        wakeLockScript = null;
    }
    // Scripts recus (via envoyerScriptService() ou depuis l'exterieur) avant que la
    // WebView headless ait fini de charger index.html : mis en attente, executes des
    // que webViewPrete passe a vrai.
    private final Deque<String> enAttente = new ArrayDeque<>();

    @Override
    public void onCreate() {
        super.onCreate();
        // Une NOUVELLE instance du service n'execute aucun script. Si le service a ete tue par
        // Android en plein script (memoire faible, application arretee de force...), le drapeau
        // "script_actif" est reste a vrai dans les preferences : l'interface croirait alors
        // qu'un script tourne encore en arriere-plan (bouton RUN grise, message "Script en
        // cours") alors que l'utilisateur n'a rien lance. On le remet donc a zero ici.
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putBoolean("script_actif", false).remove("execution_active_id").apply();
        creerCanalNotification();
        creerWebViewHeadless();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIF_ID_SERVICE, construireNotification("En veille"));

        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            arreter();
            return START_NOT_STICKY;
        } else if (ACTION_CANCEL_SCRIPT.equals(action)) {
            annulerScript();
        } else if (ACTION_RUN.equals(action) && intent != null) {
            String script = intent.getStringExtra(EXTRA_SCRIPT);
            // Un seul script a la fois. Une deuxieme pression sur FOND ne met pas un second
            // script en file d'attente et ne cree donc pas une deuxieme execution.
            if (script != null && !script.isEmpty() && !scriptActif) {
                // Reserve immediatement l'unique emplacement d'execution, meme si la WebView
                // est encore en chargement. Cela ferme la fenetre ou deux pressions FOND
                // successives pourraient sinon mettre deux scripts en file d'attente.
                compteurExecutions++;
                int idExecution = compteurExecutions;
                scriptActif = true;
                acquerirWakeLockScript();
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                    .putBoolean("script_actif", true)
                    .putInt("execution_active_id", idExecution)
                    .apply();
                if (webViewPrete) executerScript(script);
                else enAttente.addLast(script);
            } else if (scriptActif) {
                mettreAJourNotification("Script en cours");
            }
        }
        // ACTION_START (ou intent relance par le systeme apres un kill) : la WebView se
        // charge dans onCreate(), rien d'autre a faire ici.
        return START_STICKY;
    }

    private void creerWebViewHeadless() {
        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.addJavascriptInterface(new ServiceJavascriptBridge(), "MonLangageServiceNative");
        // Le moteur MLG utilise exactement la meme implementation native que MainActivity.
        // activity=null signifie que la WebView est headless : les capacites non-UI restent
        // disponibles et les actions qui exigent une interface utilisent le repli notification.
        webView.addJavascriptInterface(new MonLangageBridge(this, null), "MonLangage");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                webViewPrete = true;
                mettreAJourNotification("En veille");
                while (!enAttente.isEmpty()) executerScript(enAttente.pollFirst());
            }
        });
        // Meme contenu que MainActivity (public/index.html, synchronise par
        // "npx cap sync android" dans les assets de l'app).
        webView.loadUrl("file:///android_asset/public/index.html");
    }

    private void executerScript(String script) {
        if (!scriptActif) {
            compteurExecutions++;
            int idExecution = compteurExecutions;
            scriptActif = true;
            acquerirWakeLockScript();
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                .putBoolean("script_actif", true)
                .putInt("execution_active_id", idExecution)
                .apply();
        }
        int idExecution = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getInt("execution_active_id", compteurExecutions);
        mettreAJourNotification("Execution #" + idExecution + " en cours...");

        String scriptEchappe = JSONObject.quote(script);
        String js = "window.executerScriptExterne && window.executerScriptExterne(" + scriptEchappe + ");";
        // La fonction JS est async : le callback d'evaluateJavascript() ne doit PAS etre
        // utilise pour declarer la fin de l'execution, car il recoit immediatement le Promise.
        // La WebView appelle MonLangageServiceNative.executionTerminee(...) uniquement apres
        // le vrai retour de executerScriptExterne(). Cette fonction execute le meme moteur MLG
        // mais sans les marqueurs/invite de la console visible : MainActivity les recree a la
        // fin pour conserver exactement le comportement historique de la console.
        webView.evaluateJavascript(js, resultatBrut -> {
            // Rien : la fin reelle est signalee par le pont JS ci-dessus.
        });
    }

    private void terminerScript(String resultat) {
        if (!scriptActif) return;
        int idExecution = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getInt("execution_active_id", compteurExecutions);
        scriptActif = false;
        libererWakeLockScript();
        sauvegarderResultat(idExecution, resultat);
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putBoolean("script_actif", false)
            .remove("execution_active_id")
            .apply();
        afficherNotificationResultat(idExecution, resultat);
        // arreter.service.arriere() : le script qui vient de finir a demande l'arret --
        // on le fait maintenant (resultat deja publie/notifie), au lieu de repasser en
        // veille. Le drapeau est consomme ici, une seule fois.
        if (arretApresScriptDemande) {
            arretApresScriptDemande = false;
            arreter();
            return;
        }
        mettreAJourNotification("En veille");
    }

    private void annulerScript() {
        if (!scriptActif || webView == null || !webViewPrete) return;
        webView.evaluateJavascript("window.arreterExecutionExterne && window.arreterExecutionExterne();", null);
    }


    private class ServiceJavascriptBridge {
        @android.webkit.JavascriptInterface
        public void executionTerminee(String resultat) {
            runOnMainThread(() -> terminerScript(resultat == null ? "" : resultat));
        }

        // Appelee par arreter.service.arriere() cote MLG quand ce code tourne DANS le
        // service (script lance via le bouton FOND, execute dans la webview headless). Ne fait que
        // poser le drapeau -- ne detruit surtout pas la webview ici : on est en plein
        // milieu de l'appel JS qui vient de faire ce call, la detruire maintenant
        // reviendrait a couper la branche sur laquelle ce meme script est assis.
        // L'arret reel a lieu plus tard, dans terminerScript(), une fois le script
        // reellement termine.
        @android.webkit.JavascriptInterface
        public void demanderArretApresScript() {
            arretApresScriptDemande = true;
        }
    }

    private void runOnMainThread(Runnable action) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) action.run();
        else new android.os.Handler(android.os.Looper.getMainLooper()).post(action);
    }

    // evaluateJavascript() renvoie la valeur JS encodee en JSON (donc entre guillemets,
    // \\n echappes, etc.) -- on la redecode en texte brut lisible.
    private String decoderResultatJs(String brut) {
        if (brut == null || "null".equals(brut)) return "";
        try {
            return new JSONObject("{\\"r\\":" + brut + "}").getString("r");
        } catch (Exception e) {
            return brut;
        }
    }

    private void sauvegarderResultat(int idExecution, String resultat) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit()
            .putString("resultat_" + idExecution, resultat)
            .putString("dernier_resultat", resultat == null ? "" : resultat)
            .putInt("dernier_id", idExecution)
            .apply();
    }

    private void arreter() {
        scriptActif = false;
        libererWakeLockScript();
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putBoolean("script_actif", false).remove("execution_active_id").apply();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Retirer MonLangage des applications recentes ne doit pas detruire le service.
        // START_STICKY + absence de stopSelf() permet au moteur de continuer.
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        // Le service disparait : plus aucun script ne peut tourner. On ne laisse jamais un
        // drapeau "script_actif" perime derriere nous (voir onCreate ci-dessus).
        libererWakeLockScript();
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putBoolean("script_actif", false).remove("execution_active_id").apply();
        if (webView != null) { webView.destroy(); webView = null; }
        super.onDestroy();
    }

    private void creerCanalNotification() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager gestionnaire = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel canal = new NotificationChannel(
            CHANNEL_ID, "MonLangage (arriere-plan)", NotificationManager.IMPORTANCE_LOW);
        gestionnaire.createNotificationChannel(canal);
    }

    // Notification premiere-plan permanente, avec bouton "Arreter" -- meme principe que
    // le bouton "Arreter" de la notification "Applis actives" de Termux.
    private Notification construireNotification(String texte) {
        Intent stopIntent = new Intent(this, MonLangageService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder constructeur = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        Intent ouvrirApp = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contenuIntent = ouvrirApp != null
            ? PendingIntent.getActivity(this, 0, ouvrirApp, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
            : null;

        constructeur.setContentTitle("MonLangage actif")
                    .setContentText(texte)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setOngoing(true)
                    .addAction(0, "Arreter", stopPending);
        if (contenuIntent != null) constructeur.setContentIntent(contenuIntent);
        return constructeur.build();
    }

    private void mettreAJourNotification(String texte) {
        NotificationManager gestionnaire = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        gestionnaire.notify(NOTIF_ID_SERVICE, construireNotification(texte));
    }

    // Notification separee (pas la notification permanente) qui affiche le resultat
    // d'une execution terminee -- l'utilisateur peut la balayer sans arreter le service.
    private void afficherNotificationResultat(int idExecution, String resultat) {
        NotificationManager gestionnaire = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        String apercu = resultat == null || resultat.isEmpty() ? "(aucune sortie)" : resultat;

        Notification.Builder constructeur = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        constructeur.setContentTitle("MonLangage -- execution #" + idExecution + " terminee")
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setAutoCancel(true)
                    .setStyle(new Notification.BigTextStyle().bigText(apercu))
                    .setContentText(apercu);
        gestionnaire.notify(NOTIF_ID_SERVICE + idExecution, constructeur.build());
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
`;

fs.writeFileSync(path.join(mainActivityDir, 'MonLangageService.java'), monLangageServiceContent);
console.log('[patch-android] MonLangageService.java ecrit.');

/* ---------- 4) android/app/build.gradle : versionCode qui change a chaque build ---------- */
// "cap add android" regenere systematiquement build.gradle avec versionCode 1 fige. Sans
// versionCode different a chaque build, Android refuse d'installer la nouvelle APK par-dessus
// l'ancienne (protection anti-downgrade) et Yannick doit desinstaller l'app avant chaque
// nouvelle install manuelle. GITHUB_RUN_NUMBER augmente automatiquement de 1 a chaque
// execution du workflow (fourni par GitHub Actions) : utilise comme versionCode, il garantit
// une valeur toujours strictement croissante. En dehors de la CI (test local), on retombe sur
// l'horodatage courant en secondes (croissant lui aussi, largement sous la limite Android de
// 2 100 000 000).
const buildGradlePath = path.join('android', 'app', 'build.gradle');
let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');
const nouveauVersionCode = parseInt(process.env.GITHUB_RUN_NUMBER, 10) || Math.floor(Date.now() / 1000);
const nouveauVersionName = "1.0." + nouveauVersionCode;
buildGradle = buildGradle.replace(/versionCode\s+\d+/, 'versionCode ' + nouveauVersionCode);
buildGradle = buildGradle.replace(/versionName\s+"[^"]*"/, 'versionName "' + nouveauVersionName + '"');
fs.writeFileSync(buildGradlePath, buildGradle);
console.log('[patch-android] android/app/build.gradle : versionCode=' + nouveauVersionCode + ' versionName=' + nouveauVersionName + '.');


