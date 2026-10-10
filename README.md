# MonLangage (MLG)

**MonLangage est un langage de programmation à syntaxe française, accompagné d’un environnement de développement Android.** Il permet d’écrire des scripts `.mlg`, de les exécuter dans une console intégrée et d’utiliser les fonctionnalités proposées par le moteur ainsi que, dans l’application Android, certaines capacités natives de l’appareil.

Ce dépôt contient l’application MonLangage, son moteur intégré, sa documentation embarquée et les éléments nécessaires à la génération de l’application Android.

> **Référence fonctionnelle :** la liste détaillée des fonctionnalités, la syntaxe précise et les comportements effectivement implémentés sont documentés dans [`www/SPECIFICATION.html`](www/SPECIFICATION.html). Cette page est également destinée à être consultable hors ligne dans l’application. La commande intégrée `aide()` permet de retrouver les commandes disponibles ; `aide(nom)` affiche l’aide ciblée et `aide(spec)` ouvre la spécification complète.

---

## Sommaire

- [Présentation](#présentation)
- [Principes du langage](#principes-du-langage)
- [Ce que permet le moteur](#ce-que-permet-le-moteur)
- [L’environnement MonLangage](#lenvironnement-monlangage)
- [Architecture du dépôt](#architecture-du-dépôt)
- [Démarrer avec un script](#démarrer-avec-un-script)
- [Exemples](#exemples)
- [Exécution au premier plan et en arrière-plan](#exécution-au-premier-plan-et-en-arrière-plan)
- [Modules et paquets](#modules-et-paquets)
- [Installer les dépendances et construire l’application](#installer-les-dépendances-et-construire-lapplication)
- [Compilation automatique avec GitHub Actions](#compilation-automatique-avec-github-actions)
- [Documentation et méthode de vérification](#documentation-et-méthode-de-vérification)
- [Limites et compatibilité](#limites-et-compatibilité)
- [Contribuer au projet](#contribuer-au-projet)
- [Licence](#licence)

## Présentation

MonLangage (souvent abrégé **MLG**) est conçu pour écrire des programmes avec des mots-clés et des conventions lisibles en français. Le projet réunit :

- un moteur interprétant les scripts MonLangage ;
- un éditeur de code et une console d’exécution ;
- la gestion des fichiers source `.mlg` ;
- une documentation intégrée au projet ;
- une application Android construite avec Capacitor ;
- des fonctions du langage et des intégrations natives disponibles selon le contexte d’exécution.

L’objectif est de proposer un environnement cohérent dans lequel écrire, exécuter, tester et organiser des scripts, depuis des exemples simples jusqu’à des programmes plus structurés.

Les fonctionnalités précises dépendent de la version du moteur présente dans le dépôt. Pour éviter de maintenir plusieurs listes divergentes, la spécification embarquée et l’aide du moteur constituent les références fonctionnelles.

## Principes du langage

Quelques conventions permettent de reconnaître immédiatement du code MLG :

| Élément | Convention |
| --- | --- |
| Extension des scripts | `.mlg` |
| Extension des données MLG sérialisées | `.mld` |
| Affectation | `~` |
| Comparaison d’égalité | `==` |
| Texte littéral | |texte| |
| Commentaire | `**` en début de commentaire |
| Affichage | `affi(...)` |
| Saisie interactive | `entr(...)` |
| Condition | `si (...) { ... }` |
| Alternative | `sinon` / `sinon si` |
| Boucle | `tanqer (...) { ... }` ou `pou (...) { ... }` |
| Déclaration de fonction | `fonc nom(...) { ... }` |
| Retour d’une fonction | `retour ...` |

Les règles complètes de grammaire, les formes alternatives, les types, les opérateurs et les cas particuliers sont décrits dans [`www/SPECIFICATION.html`](www/SPECIFICATION.html). Le tableau ci-dessus est une introduction, pas une grammaire exhaustive.

## Ce que permet le moteur

Les catégories ci-dessous présentent les grands domaines couverts par le moteur. Elles ne constituent pas une garantie que chaque fonction imaginable dans ces domaines est disponible. Pour connaître les noms, paramètres, limites et conditions d’utilisation exacts, consultez la spécification livrée avec la version du dépôt.

- **Programmation générale :** variables, expressions, fonctions, portée, conditions, boucles et contrôle de l’exécution.
- **Structures et objets :** classes, méthodes, constructeurs, attributs et héritage selon les règles du moteur.
- **Données et collections :** valeurs textuelles, nombres, vecteurs, listes, dictionnaires, matrices et opérations associées.
- **Traitement du texte :** construction, recherche, découpage, remplacement, conversion et manipulation de chaînes, selon les fonctions documentées.
- **Entrées et sorties :** affichage, saisie interactive, inspection de valeurs et effacement de la console.
- **Fichiers et persistance :** sauvegarde de valeurs, lecture et écriture de fichiers, opérations sur les dossiers et partage de fichiers lorsque le contexte natif et les autorisations le permettent.
- **Modules :** répartition d’un programme en fichiers `.mlg` réutilisables.
- **Paquets :** installation et importation de modules externes lorsque le registre, le réseau et l’environnement requis sont disponibles.
- **Graphiques et dessin :** tracés et fonctions graphiques exposés par le moteur.
- **Interaction :** boutons, lecture de touches et éléments interactifs pris en charge par l’interface.
- **Temps et automatisation :** temporisation, date et heure, et fonctions de planification disponibles dans l’application native.
- **Audio et vibration :** effets sonores, notes et commandes de vibration documentés par le moteur.
- **Intégrations Android :** opérations natives proposées par l’application, avec leurs permissions et restrictions propres.
- **Gestion des erreurs :** mécanismes de traitement des erreurs et messages destinés à faciliter le diagnostic.

Les possibilités ne sont pas identiques dans tous les contextes. Par exemple, une opération qui exige une interface de saisie ne peut pas nécessairement être utilisée dans un script exécuté en arrière-plan. Certaines opérations sur les fichiers, notifications ou fonctions Android exigent l’application installée et les autorisations appropriées.

## L’environnement MonLangage

L’application fournit un environnement de travail autour du moteur :

- un éditeur permettant de travailler sur des scripts ;
- la gestion de plusieurs onglets et des opérations courantes d’édition ;
- l’ouverture et l’enregistrement de fichiers source ;
- une console pour exécuter le code et consulter les résultats ;
- une aide intégrée ;
- une spécification HTML embarquée ;
- un mode d’exécution au premier plan et un mode d’exécution en arrière-plan Android, avec des comportements distincts.

L’organisation exacte de l’interface peut évoluer. Les règles de fonctionnement du moteur et les différences entre les modes d’exécution sont précisées dans la spécification.

## Architecture du dépôt

La structure principale est organisée autour des éléments suivants :

```text
.
├── .github/
│   └── workflows/
│       └── build.yml
├── scripts/
│   └── patch-android.js
├── www/
│   ├── index.html
│   └── SPECIFICATION.html
├── alerte_demo.mlg
├── dictionnai_demo.mlg
├── capacitor.config.json
├── package.json
└── README.md
```

### Rôle des principaux fichiers

- **`www/index.html`** : point d’entrée principal de l’application web embarquée ; le moteur et l’interface de cette version du projet y sont intégrés.
- **`www/SPECIFICATION.html`** : documentation détaillée du langage et des comportements documentés du moteur.
- **`capacitor.config.json`** : configuration Capacitor, notamment l’identifiant de l’application, son nom et le dossier web embarqué.
- **`package.json`** : métadonnées du projet et dépendances JavaScript/Capacitor.
- **`scripts/patch-android.js`** : script utilisé par le processus de compilation pour appliquer des adaptations au projet Android généré.
- **`.github/workflows/build.yml`** : workflow GitHub Actions qui installe les dépendances, prépare Android et génère l’APK de débogage.
- **`alerte_demo.mlg`** et **`dictionnai_demo.mlg`** : exemples de scripts illustrant certaines fonctions du langage.

Le dossier `www/` est défini comme le dossier web de Capacitor. Il fournit donc le contenu web embarqué dans l’application Android. Le workflow du dépôt génère le projet Android pendant la compilation : il ne faut pas supposer que tous les fichiers Android générés sont suivis dans ce dépôt.

## Démarrer avec un script

1. Ouvrez MonLangage dans l’application ou dans l’environnement prévu par le projet.
2. Créez ou ouvrez un fichier `.mlg`.
3. Écrivez votre programme.
4. Lancez-le dans le mode adapté à son usage.
5. Consultez la console pour lire les résultats ou les erreurs.
6. Utilisez `aide()` ou la spécification officielle lorsque vous avez besoin de connaître la syntaxe exacte d’une commande.

### Premier programme

```mlg
** Mon premier programme MonLangage
prenom ~ |Monde|
affi(|Bonjour |, prenom, | !|)
```

Dans cet exemple, `~` affecte une valeur à une variable et `affi(...)` affiche le résultat.

### Condition et boucle

```mlg
nombre ~ 3

si(nombre == 3){
  affi(|Le nombre vaut trois.|)
} sinon {
  affi(|Le nombre est différent de trois.|)
}

pou(i dans seq(1, 3)){
  affi(|Tour : |, i)
}
```

Cet exemple illustre une condition et une boucle. Pour les formes exactes de `seq`, `pou`, les blocs et les opérateurs, référez-vous à la spécification de la version utilisée.

### Fonction

```mlg
fonc carre(x){
  retour x * x
}

affi(carre(5))
```

Les fonctions, leurs paramètres, les valeurs par défaut et les règles de retour sont détaillés dans la documentation du moteur.

## Exemples

Deux fichiers d’exemple sont inclus dans le dépôt :

- **`alerte_demo.mlg`** : exemple d’utilisation de fonctions d’alerte, de son et de vibration. Certaines parties nécessitent l’application Android installée et doivent être testées dans le contexte prévu.
- **`dictionnai_demo.mlg`** : exemple de dictionnaire, de collections, de parcours, de tri et de manipulation de texte.

Ces exemples sont des points de départ, et non une liste complète des capacités du langage.

## Exécution au premier plan et en arrière-plan

L’application distingue deux modes :

- **`RUN`** : exécution dans la console visible de l’application. C’est le mode à privilégier lorsqu’un script demande des saisies interactives avec `entr()` ou doit afficher progressivement des résultats dans la console.
- **`FOND`** : exécution explicitement demandée dans le service Android prévu à cet effet. Ce mode permet au script de continuer lorsque l’interface de l’éditeur n’est plus affichée, dans les limites imposées par Android et l’appareil.

Le mode arrière-plan n’est pas une copie parfaite du mode interactif : aucune console de saisie interactive n’y est présentée, et les commandes dépendant de l’interface peuvent être indisponibles. Les restrictions du système, l’économie d’énergie et les autorisations Android peuvent aussi influer sur le comportement.

Pour les règles exactes de l’exécution, du stockage, des arrêts et des fonctions disponibles dans chaque mode, consultez la section correspondante de `www/SPECIFICATION.html`.

## Modules et paquets

### Modules locaux

Les programmes peuvent être répartis entre plusieurs fichiers `.mlg`. Les formes d’importation, les préfixes de modules, les alias, les imports sélectifs et la résolution des chemins sont décrits dans la section consacrée aux modules de la spécification.

Exemple indicatif :

```mlg
import(outils)
outils.maFonction()
```

Cet exemple suppose qu’un module `outils.mlg` existe à l’emplacement recherché par le moteur.

### Paquets externes

Le projet documente un système de paquets distinct des modules locaux. Les paquets externes sont distribués par le dépôt de paquets configuré dans le moteur. Leur disponibilité dépend notamment du registre, de la connexion réseau et des règles de validation appliquées à leur installation.

Le gestionnaire de paquets intégré à l’application ne doit pas être confondu avec une instruction du langage. Consultez la spécification pour connaître la structure attendue d’un paquet, les commandes disponibles, les règles de sécurité et les limitations de cette version.

## Installer les dépendances et construire l’application

### Prérequis

Le workflow de compilation présent dans le dépôt utilise :

- **Node.js 20** ;
- **npm** ;
- **Java 17** ;
- **Capacitor 6** et les dépendances définies dans `package.json` ;
- les outils Android/Gradle téléchargés ou préparés par le processus de compilation.

Les versions réellement utilisées doivent rester cohérentes avec le workflow et les fichiers de configuration du dépôt.

### Installation des dépendances

À la racine du dépôt :

```bash
npm install
```

### Préparation Android et compilation locale

Le workflow GitHub Actions effectue les étapes principales suivantes :

```bash
npx cap add android
npx cap sync android
node scripts/patch-android.js
cd android
chmod +x ./gradlew
./gradlew assembleDebug
```

Ces commandes reflètent le processus décrit dans le workflow actuel. `npx cap add android` crée la plateforme Android lorsqu’elle n’existe pas ; il ne faut pas la relancer aveuglément dans un environnement où un projet Android préexistant doit être conservé. Pour une compilation locale, vérifiez les prérequis, l’état du dossier `android/` et les versions d’outils disponibles.

Si la compilation échoue, examinez d’abord l’étape exacte qui a échoué et son journal complet : installation npm, synchronisation Capacitor, script de patch, compilation Java/Gradle ou génération de l’APK.

## Compilation automatique avec GitHub Actions

Le workflow [`.github/workflows/build.yml`](.github/workflows/build.yml) est configuré pour se lancer :

- lors d’un `push` sur la branche `main` ;
- manuellement depuis l’onglet **Actions** de GitHub, via `workflow_dispatch`.

Le workflow récupère le dépôt, installe Node.js et les dépendances, prépare la plateforme Android, synchronise le dossier web, applique le patch Android, installe Java 17 puis lance la compilation de débogage.

Lorsque la compilation réussit, l’APK est publié comme artefact GitHub Actions sous le nom :

```text
monlangage-apk
```

Le chemin d’artefact déclaré dans le workflow est :

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Pour récupérer l’application, ouvrez l’exécution du workflow dans GitHub Actions et téléchargez l’artefact associé. Un build réussi confirme que l’APK a été généré ; il ne remplace pas les tests sur appareil, notamment pour les permissions, les fichiers, les notifications, les services et les fonctions natives.

## Documentation et méthode de vérification

Pour obtenir une information fiable, utilisez les sources dans cet ordre :

1. **L’implémentation actuelle** dans `www/index.html` pour vérifier ce que le moteur exécute réellement.
2. **`www/SPECIFICATION.html`** pour les règles du langage, les signatures, les exemples et les limitations documentées de cette version.
3. **`aide()`**, `aide(nom)` et `aide(spec)` dans l’application pour consulter l’aide intégrée.
4. **Les fichiers d’exemple `.mlg`** pour observer des usages concrets.
5. **Le workflow de compilation** pour vérifier les étapes de construction de l’application.

### Une documentation conçue pour évoluer

Le README présente volontairement les fonctionnalités par grandes catégories au lieu d’énumérer chaque commande. Lorsqu’une nouvelle fonction est ajoutée au moteur, la mise à jour du README n’est donc généralement pas nécessaire si cette fonction s’inscrit dans une catégorie déjà présentée.

En revanche, toute nouvelle fonctionnalité doit être documentée dans la référence fonctionnelle appropriée, avec sa syntaxe, ses paramètres, ses comportements, ses restrictions et des exemples pertinents. Le README doit être revu lorsque changent les grandes capacités du projet, son architecture, ses prérequis ou son processus d’installation et de compilation.

Aucune documentation générale ne peut garantir qu’elle décrira à l’avance chaque évolution future. La référence embarquée doit donc rester alignée sur l’implémentation réellement publiée.

## Limites et compatibilité

- Les fonctionnalités disponibles sont celles de la version du moteur présente dans ce dépôt ; une catégorie générale ne garantit pas la présence d’une fonction particulière.
- Certaines commandes nécessitent l’application Android plutôt qu’un simple navigateur.
- Les fonctions natives dépendent du pont Android, des permissions accordées, de la version d’Android et des restrictions du fabricant.
- Le comportement en arrière-plan peut différer de celui de l’exécution dans la console visible.
- Les opérations réseau et l’installation de paquets externes nécessitent une connexion et dépendent du dépôt configuré.
- Un APK qui compile doit encore être testé sur un appareil réel pour valider le comportement fonctionnel.

## Contribuer au projet

Avant de modifier le moteur :

1. Identifiez le comportement existant dans `www/index.html`.
2. Vérifiez les règles correspondantes dans `www/SPECIFICATION.html` et l’aide intégrée.
3. Modifiez le moteur sans supprimer involontairement les comportements déjà pris en charge.
4. Mettez à jour la spécification lorsqu’une syntaxe, une commande, une règle ou une limitation change.
5. Ajoutez ou adaptez un exemple `.mlg` lorsque cela aide à valider le comportement.
6. Lancez la compilation GitHub Actions et vérifiez le journal complet.
7. Testez sur Android les fonctions qui dépendent de l’appareil, des permissions, du stockage ou des services.

Les modifications du moteur, de la documentation et du processus de compilation doivent rester cohérentes. Les fonctions non testées ne doivent pas être présentées comme garanties.

## Licence

Aucune licence open source n’est déclarée dans les fichiers examinés de cette archive. Avant de redistribuer, modifier ou réutiliser ce projet, consultez le dépôt d’origine et ajoutez un fichier `LICENSE` si tu souhaites publier explicitement les conditions de réutilisation.
