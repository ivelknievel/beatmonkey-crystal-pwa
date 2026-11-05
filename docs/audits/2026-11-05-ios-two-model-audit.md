# Beatmonkey Crystal — iOS PWA onderzoek en codereview

Datum: 5 november 2026. Status: onderzoeks- en reviewfase; geen applicatiecode, gitgeschiedenis, configuratie of deployment gewijzigd. Bestaande lokale wijzigingen zijn behouden. Dit document is de gecontroleerde synthese; het vervangt te stellige conclusies uit de eerste AI-audit.

## 1. Conclusie

De bestaande React/TypeScript-PWA is een bruikbare basis. Een complete herbouw is op basis van deze inspectie niet nodig. Voor een muziekapp moet de volgorde echter zijn: betrouwbaar afspelen, betrouwbaar hervatten en inloggen, daarna offline gedrag en visuele afwerking. Een geslaagde Chromium-rooktest bewijst geen betrouwbare iPhone-muziekspeler.

De grootste aantoonbare tekortkomingen zijn de onvolledige service-workerstrategie, beperkte testdekking, onvolledige herstel-/foutpaden in de speler en ontbrekende OAuth-requestbinding in de frontend. Mogelijke iOS-specifieke audio-, toetsenbord- en OAuthproblemen moeten op een echte iPhone worden gereproduceerd voordat we hun oorzaak als bewezen behandelen.

## 2. Wat echt gecontroleerd is

- Broncode: `/opt/beatmonkey-pwa`, inclusief de bestaande dirty working tree. HEAD: `5c86ce3`, onderwerp: authenticated browser share route preserves set timestamp.
- Caddy serveert `/app*` voor het muziekhost daadwerkelijk uit `/opt/beatmonkey-core/static/pwa`; onafhankelijk uit de actieve configuratie teruggelezen.
- `dist/index.html` en de actieve webroot hebben onafhankelijk gecontroleerd dezelfde SHA-256: `7418baae90ed1fb1d407b4c5f281b20b74b9a5a7524562248bc8b3fd9a5f5307`. Beide verwijzen naar `index-sIaluJlx.js`.
- `/opt/beatmonkey-pwa-served` is een afwijkende snapshot, niet de actuele webroot. Die verwijst naar `index-BJRDGKv4.js`. Alleen de mapnaam 'served' is dus geen betrouwbaar bewijs van de live versie.
- De uitgevoerde Playwright-opdracht meldde `3 passed (6.0s)`, exitcode 0. Dit is in de opgeslagen commandoutput geverifieerd.
- Lint eindigde met exitcode 0 maar bevat waarschuwingen. Het ruwe rapport noemt 11; die telling is niet als harde conclusie overgenomen. Onder andere refgebruik, hookdependencies en mutatie van de visualizer-prop worden gemeld.
- `npx tsc --noEmit` eindigde met exitcode 0. BELANGRIJKE CORRECTIE: root `tsconfig.json` heeft `files: []` en projectreferences. Zonder buildmodus of expliciete `-p` is dit geen sluitend bewijs dat de applicatiebronnen zijn gecontroleerd. Een aanvullende expliciete projectcheck werd door de uitvoeringsbeveiliging geblokkeerd wegens de bestandsgrootte van TypeScript. Geen nieuwe buildclaim.
- Geen fysieke iPhone, simulator of WebKit-browser gebruikt. Geen echte Google-accountlogin uitgevoerd. Geen geauthenticeerde audiostream of HTTP Range-respons end-to-end gecontroleerd.

## 3. Actuele iOS-kennis die het ontwerp beïnvloedt

### Installatie en app-identiteit

WebKit documenteert voor iOS/iPadOS 26 dat elk via het beginscherm toegevoegd websiteadres standaard als webapp kan openen. De gebruiker kan dit bij toevoegen uitschakelen. Oude handleidingen met 'zonder manifest geen standalone iPhone-app' zijn daarom niet actueel. Een manifest blijft wel nuttig voor naam, iconen, startadres en identiteit. [S1]

Crystal heeft al een manifest, `display: standalone`, `start_url: /app/`, Apple-webappmetatags, een touch-icon en `viewport-fit=cover`. Aanbevolen aanvullingen: expliciete stabiele `id` en `scope`, passend Apple-touch-icon en begrijpelijke installatiehulp die onderscheid maakt tussen Safari en al geïnstalleerde modus. Het ontbreken van `id`/`scope` bewijst op zichzelf geen installatiebug: browsers hebben defaults.

### Gebruikersinteractie en eerste playback

iOS heeft expliciet beleid voor het starten van media; ga niet uit van desktopautoplay. WebKit onderscheidt sticky en transient activation, en sommige API's verbruiken een activatie. Een willekeurige `await` betekent niet automatisch dat alle activatie vervalt: duur, API, elementhistorie en browserbeleid zijn relevant. [S4, S7]

Ontwerp: resolve songmetadata zo mogelijk vooraf; start het juiste herbruikbare audio-element vanuit een echte gebruikersactie; behandel de Promise van `play()`; geef bij blokkering een duidelijke tik-om-af-te-spelenactie. Gebruik geen onbewezen stille-audiotruc als structurele oplossing.

### Achtergrondaudio, Web Audio en Audio Session

Onderscheid gewone HTML-mediaweergave van een Web Audio-grafiek voor visualisatie. De Audio Session-specificatie beschrijft onder andere `playback`, `ambient` en audiofocus. Dat is ontwerpinformatie, geen garantie dat elk iOS-release-/hardwarepad hetzelfde werkt. Gebruik featuredetectie voor `navigator.audioSession`, en onderzoek `type = 'playback'` waar ondersteund. [S5]

Voor Crystal is een vergelijking nodig tussen dezelfde set via alleen HTMLAudioElement en via de analysergrafiek. Test vergrendelen, appwisselen, hervatten, onderbreking en bluetooth. Bewering 'een PWA kan nooit achtergrondmuziek afspelen' is te algemeen. Andersom is 'MediaSession garandeert achtergrondweergave' ook onjuist.

Een eenmaal met `createMediaElementSource()` gekoppeld audio-element wordt niet simpelweg weer een gewone mediaspeler door de node te disconnecten. Een onzorgvuldige 'fix' kan juist stilte maken. Ontwerp de audiopipeline vooraf of herinitialiseer gecontroleerd; eerst testen.

### Lockscreen en bediening

Media Session biedt metadata, playbackState, positie en actionhandlers. Ondersteuning en zichtbare systeembediening verschillen; registreer handlers defensief en verwacht niet dat alle acties overal zichtbaar zijn. De API vervangt geen werkende mediaspeler. [S9]

### Opslag en offline

Sinds Safari 17 beschrijft WebKit volledige Storage API-ondersteuning en quota op basis van schijfruimte. `estimate()`, `persisted()` en `persist()` helpen, maar blijven capability-/beleidsafhankelijk. Beginschermapps hebben volgens die documentatie dezelfde quota als browserapps. Een aanvraag voor persistence is geen garantie. De algemene uitspraak 'iOS wist altijd alle PWA-data na zeven dagen' is geen verantwoorde ontwerpregel. [S2]

Maak onderscheid tussen offline app-shell en offline muziek. De eerste moet een bruikbare interface/foutmelding geven zonder netwerk; de tweede vereist expliciete downloads, capaciteit, voortgang, verwijdering en een getest streaming-/seekmodel. Niet elke API-respons of audiostream blind via de service worker cachen. Service workers zijn eventgedreven en geen permanente achtergrondmuziekdienst. [S10]

### Push

WebKit introduceerde Web Push voor beginschermwebapps met iOS/iPadOS 16.4. Toestemming moet passend vanuit gebruikersinteractie worden gevraagd. Voor een muziek-PWA kan dit later nuttig zijn voor bijvoorbeeld een nieuwe spotlight, maar het lost geen afspeelprobleem op en heeft nu geen voorrang. [S3]

### Lay-out, toetsenbord en toegankelijkheid

`viewport-fit=cover` vereist bewust gebruik van safe-area-insets, niet alleen onderaan maar ook bovenaan en in landschap. WebKit beschrijft hiervoor `env(safe-area-inset-*)`. [S8]

Test dynamische viewporthoogte, toetsenbord, scrollcontainers en overlays samen. Maak invoervelden voldoende groot, laat zoomen toe, voorzie echte labels, zichtbare focus, toegankelijke sliders/dialogen en reduced-motiongedrag. Kleine lettergroottes zijn een bekende iPhone-focuszoomrisicofactor, maar de huidige fout is niet op hardware gereproduceerd. `user-scalable=no` wordt bovendien niet overal afgedwongen: 'de gebruiker kan gegarandeerd nooit uitzoomen' is te stellig.

## 4. Concrete codebevindingen en verbeteringen

### A. Service worker: app-shell niet betrouwbaar offline — hoge prioriteit

Bewijs: `public/service-worker.js:9-13` precachet alleen HTML en manifest. Regels 28-35 proberen assets vanaf netwerk te halen en anders `caches.match()` te gebruiken, maar slaan die assets niet op. Er is geen offline navigatiefallback voor willekeurige `/app/...`-routes.

Gevolg: de service worker biedt geen betrouwbare offline appstart. Een incidentele start via de gewone HTTP-cache blijft mogelijk; 'offline werkt gegarandeerd nooit' is daarom te absoluut.

Verder verwijderen regels 6-7 en 20-21 alle CacheStorage-caches met een andere naam. Dat kan caches van andere apps op dezelfde origin verwijderen, omdat CacheStorage niet per service-worker-scope geïsoleerd is. `skipWaiting()`/`clients.claim()` zijn daarnaast onvoorwaardelijk en kunnen zonder afgestemd updateprotocol een actieve sessie overnemen.

Verbetering: gegenereerde, versiegebonden precache met bundelhashes; alleen eigen cacheprefix opruimen; navigatiefallback; expliciete bypass voor auth, muterende requests en streaming; gecontroleerde updateprompt waarbij de speler niet abrupt opnieuw wordt geladen. Bewaar oude release-assets tot oude clients zijn uitgefaseerd: niet direct alle 'oude' chunks wissen.

### B. Eerste afspeelactie en foutafhandeling — hoge prioriteit

Bewijs: `src/stores/playerStore.ts:100-136` doet eerst `await getAlbum()` en roept daarna de engine aan. `src/engine/AudioEngine.ts:339-344` vangt een geweigerde `play()` alleen met een consolewaarschuwing af. De laadstatus kan daardoor voor de gebruiker onduidelijk blijven.

Bevestigd: foutpad geeft geen expliciete gebruikersactie/status bij die weigering. Niet bewezen: elke eerste tik faalt op iOS.

Verbetering: expliciet spelerstatusmodel (idle/loading/ready/playing/paused/blocked/error); voorbereiden van song-id; duidelijke herstelknop; racebeveiliging zodat een laat antwoord van een eerder gekozen set de nieuwste keuze niet overschrijft. Test met langzaam netwerk en snelle opeenvolgende keuzes.

### C. Hervatten na herstart is onvolledig — hoge prioriteit

Bewijs: `playerStore.ts:179-209` herstelt metadata, positie en queue in de store, maar laadt daar geen audio-src in de engine. `AudioEngine.play():348-360` speelt alleen het bestaande audio-element af. Dit pad vereist een gerichte regressietest: herstelde minispeler zichtbaar, vervolgens op play drukken zonder de set opnieuw te openen.

Daarnaast gebruikt regel 201 `pq.position > 1000 ? pq.position / 1000 : pq.position`, terwijl andere code de serverpositie als milliseconden behandelt. Eenheden niet raden aan de hand van de grootte: leg het contract vast en converteer consequent.

Bewijs: `AudioEngine.ts:83-90` leest id/positie vóór de await maar werkt een globale save-timestamp erna bij. Samen met setwissels en parallelle saves is dit een race-risico. Maak save-opdrachten generatiegebonden en sla periodiek lokaal op, niet uitsluitend via async unload-events.

### D. Web Audio en MediaSession — hoge testprioriteit

Bewijs: `AudioEngine.ts:37-40` routeert het audio-element via analyser/destination; `play():349` vraagt de AudioContext aan. Er is geen aangetoond iPhone-achtergrondtestresultaat.

Bewijs: `AudioEngine.ts:120-146` registreert play/pause/seek maar niet previous/next, en werkt playbackState niet expliciet bij. Dit is een bevestigde implementatiebeperking; de exacte lockscreenweergave is niet gemeten.

Verbetering: gewone audio als robuuste baseline; visualisatie niet de voorwaarde voor geluid; defensieve MediaSession-handlers en correcte staat; onderzoek onderbrekings-/resume-events. Volumeweergave afstemmen op daadwerkelijk platformgedrag in plaats van aannemen dat `audio.volume` op elke iPhone softwarematige controle geeft.

### E. OAuth en credentials — beveiligingsprioriteit

Bewijs: `GoogleLoginButton.tsx:12-18` gebruikt `response_type: code id_token`, maakt een nonce met `Math.random()`, maar bewaart die niet; er staat geen `state` in de request. `auth.callback.tsx:23-33` leest id_token uit het fragment en logt daarmee in, zonder frontendvergelijking met de aangevraagde nonce/state. De servervalidatie is niet volledig geaudit: geen exploitclaim.

Google documenteert requestbinding met een anti-forgery state-token en nonce/replaybescherming. Kies een coherent, ondersteund server-/codeflowontwerp met cryptografische randomness en verificatie; PKCE waar passend. [S6]

Bewijs: `authService.ts:43-48,95-98` schrijft Subsoniccredentials naar browseropslag. Caddy verwijdert voor `/app*` de CSP. Dat vergroot het belang van XSS-bescherming en credentialminimalisatie. Onderzoek een server-beheerde sessie/HttpOnly-cookie en een beschermde streamingproxy; een audio-element kan niet willekeurig dezelfde Authorization-header injecteren als fetch.

Apart runtime-risico: extern inloggen vanuit een geïnstalleerde iPhone-webapp kan een ander browser-/opslagpad gebruiken. Dit is niet gereproduceerd en mag niet worden afgedaan als onvermijdelijk stuk. Test terugkeer naar exact dezelfde gedeelde set en timestamp, uitloggen, opnieuw starten en verlopen sessie.

### F. Gedeelde links en navigatie — hoge prioriteit

Bewijs: `FullscreenPlayerOverlay.tsx:85-88` deelt `/go/album/{id}` met eventueel `t`. De onderzochte serverhandler verwijst naar het custom schema `beatmonkeycrystal://link/...`; de webroute `/app/set/{id}` bestaat al in de huidige broncode.

Aanbeveling: deel één HTTPS-link die zonder geïnstalleerde native app altijd een werkende browserbestemming heeft en timestamp bewaart. Eventueel eerst een landingspagina met 'open app' én webfallback. De letterlijke iPhone-foutmelding is niet op een toestel gezien.

### G. Safe areas, inputs en animaties — middelhoge prioriteit

Bewijs: `index.html:5` beperkt zoomen; meerdere inputs gebruiken `text-sm`; `TracklistSection.tsx:481` heeft zelf geen bottom-inset. Beoordeel de volledige overlay inclusief ancestors vóór een inset wordt toegevoegd: dubbele padding voorkomen. Visuele overlap is een te testen risico, niet een reeds gefotografeerde fout.

Bewijs: `WaveCurveCanvas.tsx:58` leest afmetingen in een animatiepad. Dat is een optimalisatiekandidaat, maar een layout-read betekent niet automatisch layout thrashing zonder voorafgaande invalidatie. Meet eerst. ResizeObserver, stop bij onzichtbaarheid, reduced motion en minder allocaties zijn logische verbeteringen.

## 5. Testdekking: belangrijker dan de groene vinkjes

`playwright.config.ts:11-15` configureert alleen Desktop Chrome. De tests bezoeken de bestaande live site, niet automatisch de huidige working tree.

- `tests/auth-flow.spec.ts:4-12`: de test met naam 'Google sign-in button' logt alleen een boolean; er is geen assertion dat die knop bestaat. Kan dus groen zijn terwijl hij ontbreekt.
- Regels 14-20: de callbacktest verlangt alleen niet-lege bodytekst. Ook een zichtbare authenticatiefout kan slagen.
- Regels 23-47: de IndexedDB-roundtrip is een nuttige maar beperkte echte assertion; testdatabase wordt verwijderd.

Voeg echte verwachtingen toe voor login, hervatten, setkeuze, foutstatus, timestamp, caching en updates. Gebruik Chromium én Playwright WebKit voor snelle regressies, maar behandel die laatste niet als volledige iPhone-/standalone-/lockscreenemulatie.

## 6. Aanbevolen uitvoeringsvolgorde

1. Baseline vastleggen: bestaande dirty wijzigingen veiligstellen en scheiden, actieve release identificeren, minimale iPhone-repro vastleggen.
2. Spelerpaden: eerste start, herstel van audio-src en positie, foutmelding bij play-blokkade, setwisselraces.
3. Sessies en links: OAuth-requestbinding/servervalidatie, credentialstrategie, werkende HTTPS-deellink met timestamp.
4. Service worker: echte app-shellprecache, eigen cachebeheer, veilige releases/updateprompt. Offline audio als afzonderlijke productkeuze.
5. iPhone-afwerking: safe areas, toetsenbord, invoergrootte, zoomen, touchtargets, focus en reduced motion.
6. Gerichte regressies in CI plus hardwarecontrole vóór productie-deploy.

Geen volledige rewrite, nieuwe frameworkkeuze of native wrapper rechtvaardigen zonder eerst deze fouten en testgaten aan te pakken.

## 7. Acceptatie op een fysieke iPhone

Test minstens de daadwerkelijk gebruikte iOS-versie plus de gekozen minimale ondersteunde versie. Gebruik geen willekeurig verouderde matrix met alleen iOS 17/18.

- Safari én beginschermapp: installatie, koude start, herstart, update met oude service worker.
- Inloggen, uitloggen, terugkeer vanuit Google, verlopen sessie, beschermd gedeeld adres met timestamp.
- Set starten met eerste tik, pauzeren/hervatten, langzame verbinding en snelle setwissel.
- Vergrendeld scherm en andere app gedurende ten minste 5 minuten; langere livesettest; headset/bluetooth; inkomende oproep.
- Lockscreen play/pause/seek; einde van set en queueovergang als dat gewenst gedrag is.
- Seek ver in een lange set, HTTP Range/206 en Content-Range controleren; wifi/mobiel overgang en offline naar online.
- Portret/landschap, safe areas, toetsenbord, zoom, grote tekst en VoiceOver.
- Offline shell geeft een bruikbare toestand. Offline muziek alleen beloven indien expliciete downloadfunctie is gebouwd en getest.
- Bewijs: screenshots/schermopname, iOS-versie, console-/netwerklog zonder tokens en reproduceerbare stappen.

## 8. Primaire bronnen

Deze bronnen zijn daadwerkelijk opgehaald tijdens het onderzoek. Een standaard/explainer is geen belofte van identieke implementatie in alle iOS-versies. Historische WebKit-posts worden alleen voor hun onderwerp gebruikt, niet als bewijs van de nieuwste totale browserondersteuning.

- [S1 WebKit: Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) — beginscherminstallatie, manifestcontext en recente platformmogelijkheden.
- [S2 WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/) — quota, eviction en persistence.
- [S3 WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) — push en beginschermwebapps.
- [S4 WebKit: The User Activation API](https://webkit.org/blog/13862/the-user-activation-api/) — activatie en API-interactie.
- [S5 W3C Audio Session explainer](https://github.com/w3c/audio-session/blob/main/explainer.md) — audiofocus en sessietypen; geen compatibiliteitsgarantie.
- [S6 Google: OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) — state, nonce en tokenvalidatie.
- [S7 WebKit: New video policies for iOS](https://webkit.org/blog/6784/new-video-policies-for-ios/) — historische primaire uitleg van media-/gebruikersinteractiebeleid; test actueel audiogedrag apart.
- [S8 WebKit: Designing websites for iPhone X](https://webkit.org/blog/7929/designing-websites-for-iphone-x/) — viewport-fit en safe-area-insets.
- [S9 W3C Media Session](https://w3c.github.io/mediasession/) — metadata, state en actionhandlers.
- [S10 W3C Service Workers](https://w3c.github.io/ServiceWorker/) — lifecycle, fetch en opslag-/scopecontext.

## 9. Uitvoeringsstatus van de gedelegeerde review

De eerste AGY-run voerde aantoonbaar tools en tests uit maar eindigde zonder het gevraagde rapportbestand. Dat was dus geen complete oplevering. In de gecontroleerde uitvoer is geen quota-exhaustion aangetroffen; de exacte reden van beëindiging is niet sluitend vastgesteld. Vervolgens is dezelfde conversatie hervat met de beperkte opdracht alleen het bestaande bewijs uit te schrijven. Die vervolgopdracht eindigde met status SUCCESS en proces-exitcode 0; het rapport is onafhankelijk teruggelezen. Onvoldoende onderbouwde conclusies zijn in deze synthese expliciet gecorrigeerd. De app is niet gewijzigd of gedeployed.

---

## 10. Tweede codereview — GPT-6.1 Sol

**Reviewer:** GPT-6.1 Sol, rechtstreeks in deze sessie; geen Gemini-/Antigravitydelegatie voor deze tweede review.  
**Uitgevoerd:** 5 november 2026; broninspectie gestart om 16:14 UTC, definitieve reproductierun om 16:18:30 UTC.  
**Basis:** huidige working tree bij commit `5c86ce377d33a846f2466cfaeaf1d5b91455ff95`, inclusief bestaande ongecommitte wijzigingen.  
**Werkwijze:** eigen broninspectie, controle van de eerdere audit en gerichte uitvoerbare reproducerende controles. Dit is een tweede modelreview met kennis van de eerste audit, geen geblindeerde review in een context zonder voorkennis. Hoofdstukken 1–9 zijn ongewijzigd behouden.

### 10.1 Samenvattend oordeel

De eerdere conclusie om niet direct te herbouwen blijft staan. De belangrijkste aanvulling is dat een aanzienlijk deel van de problemen **platformonafhankelijke state-/asynchroniteitsfouten** is. Alleen iOS-workarounds toevoegen zou die niet oplossen.

Hoogste prioriteit: album- en songidentiteit scheiden; setselectie en hervatten racebestendig maken; uitloggen en accountwisselen volledig afhandelen; applicatiefouten van Subsonic herkennen; veilige service-workerupdates. De bestaande audio-/OAuth-/layoutvragen op een fysieke iPhone blijven daarnaast openstaan.

### 10.2 Wat deze review daadwerkelijk heeft uitgevoerd

Een auditrunner is buiten de repository gemaakt:

- Runner: `/root/.hermes/cache/scratch/pwa-sol61-audit-repro.mjs`.
- Bewijs: `/root/.hermes/cache/scratch/pwa-sol61-audit-evidence.json`.
- Opdracht: `node /root/.hermes/cache/scratch/pwa-sol61-audit-repro.mjs`.
- Definitieve uitvoering: **exitcode 0; 16 van 16 scenario's reproduceerden het bedoelde foutpad; 0 niet-gereproduceerd**.

De runner leest de echte TypeScript-modulebodies, verwijdert type-annotaties met Node `stripTypeScriptTypes` en vervangt uitsluitend de module-importkoppelingen door expliciete testdependencies. De store gebruikt de daadwerkelijk geïnstalleerde Zustand vanilla-implementatie. Audio, browserglobals, opslag en API-antwoorden zijn gecontroleerde simulaties. De service-workerbron wordt als echt JavaScript uitgevoerd in een geïsoleerde VM-context.

**Interpretatie:** dit zijn defectreproducties, geen 16 geslaagde functionele producttests en niet noodzakelijk 16 onafhankelijke bugs. Verschillende scenario's bevestigen eerdere vermoedens of delen dezelfde hoofdoorzaak. Geen echte credentials, Google-login, productiemutaties of fysieke iPhone gebruikt. Gesimuleerde netwerkantwoorden zijn testfixtures, geen gepresenteerde productiegegevens.

De SHA-256 van elk dynamisch getest bronbestand is vóór/na gecontroleerd: **geen verandering**. De bestaande git-status blijft behouden. De eerste runnerstart had een onjuist pad naar de Zustand-module en is vóór de definitieve run gecorrigeerd; daarna zijn alle genoemde scenario's echt uitgevoerd. Typeverwijdering is geen TypeScript-typecheck of build.

### 10.3 Bevindingen met uitvoerbaar bewijs

#### SOL-01 — P1: album-id wordt overschreven door song-id

**Bron:** `src/stores/playerStore.ts:98-107,117-136,370-372`; `src/engine/AudioEngine.ts:332-335`.

De store zet `currentSetId` op het album-id. Vervolgens krijgt `AudioEngine.loadSet()` het song-id. De engine emit dat song-id opnieuw onder de naam `currentSetId`, waarna de store dit ongefilterd overneemt.

**Reproductie:** na laden van `album-A` is `currentSet.id = album-A`, maar `currentSetId = song-album-A`.

**Gevolg:** `SetCard.tsx:15-17` en `DJDetailPage.tsx:181` vergelijken met het album-id en herkennen de huidige set niet correct. `TracklistSection.tsx:103-111` gebruikt diezelfde identifier voor tracklistopvraging; `discoveryApi.ts:556` stuurt hem zelfs als `album_id`. Of een backend toevallig een song-id accepteert, verandert de interne contractbreuk niet.

**Advies:** expliciete `currentAlbumId`/`currentSongId`, en één consistente definitie van `currentSetId`. Regressietest: normale albumselectie houdt kaartmarkering, tracklist en deel-id gelijk aan de metadata-identiteit.

#### SOL-02 / SOL-03 — P1/P2: hervatten herstelt geen bron en raadt tijdseenheden

**Bron:** `playerStore.ts:179-209`; `AudioEngine.ts:348-360`.

De eerdere bevinding is nu uitgevoerd in de auditrunner. Een queuepositie van 42.000 ms levert `currentTime = 42` in de interface op, maar `audio.src` blijft leeg en de engine heeft geen currentSongId. Een werkende enginebron wordt dus niet door dit herstelpad voorbereid.

Een tweede scenario met serverpositie 500 levert **500 seconden** op in plaats van 0,5 seconde, door de grenswaardeheuristiek op regel 201. Dat tweede geval betreft korte posities die bijvoorbeeld een andere client kan opslaan; de eigen engine slaat posities onder 10 seconden niet op.

**Advies:** bron en metadata gecontroleerd herstellen zonder ongewenste autoplay; bij gebruikersactie op de bedoelde positie starten. Positie-eenheid vastleggen in het API-contract. Geen milliseconden/seconden gokken aan de hand van de waarde.

#### SOL-04 — P1: oude selectie wint van de laatste gebruikerskeuze

**Bron:** `playerStore.ts:94-136`.

Elke `loadSet` wacht onafhankelijk op `getAlbum()`. Er is geen requestgeneratie, annulering of controle of deze keuze nog actueel is.

**Reproductie:** gebruiker kiest A en daarna B. B's metadata komt eerst terug, A's metadata later. Het uiteindelijke actieve album is **A**.

**Advies:** monotone selectiegeneratie met controle na iedere await; annuleer oude requests waar mogelijk. Alleen de nieuwste keuze mag speler, queue en status wijzigen. Dit is ook relevant bij traag mobiel internet op iPhone.

#### SOL-05 — P1: laat hervatantwoord van A spoelt B door

**Bron:** `playerStore.ts:139-167`.

De match op `sameAlbum` betreft het lokale `setInfo` van de oudere aanroep, niet de inmiddels actuele enginebron. Daarna wordt onvoorwaardelijk `AudioEngine.seekTo()` uitgevoerd.

**Reproductie:** A start; A's queueantwoord blijft hangen; B start; daarna komt A's positie van 125 seconden terug. De engine speelt B, maar B wordt naar **125 seconden** verplaatst.

**Advies:** bind het queueantwoord aan dezelfde set-/songgeneratie als de oorspronkelijke laadopdracht. Controleer die identiteit opnieuw vóór een seek. Alleen `AbortController` voor de eerste metadatafetch is niet voldoende.

#### SOL-06 / SOL-08 / SOL-09 — P1: account- en sessielevenscyclus is niet sluitend

**Bron:** `useAuthStore.ts:45-75,110-120`; `RootLayout.tsx:14,30-35,43-69`; `playerStore.ts:301-307`; `SettingsPage.tsx:10-15`; `FavoritesPage.tsx:18-30`.

Er zijn meerdere samenhangende problemen:

1. `logout()` verwijdert credentials en authstate, maar stopt de engine niet en wist set, queue en favorieten niet. In de runner blijft na logout het audio-element spelen en blijven de oude set/favorieten in de store.
2. `RootLayout` heeft daarnaast eigen lokale `isLoggedIn`-state. Zodra die true is geworden, zet een Google-logout hem niet terug. De zichtbare loginpoort is hierdoor niet volledig gekoppeld aan de authstore. Dit React-pad is statisch gecontroleerd, niet als volledige UI-test uitgevoerd.
3. De aparte Subsonic-uitlogknop in Settings verwijdert niet het Google-JWT. Na reload kan de Google-authstore zichzelf daardoor opnieuw als authenticated presenteren terwijl Subsoniccredentials ontbreken.
4. `checkSession()` zet bij ontbrekend/ongeldig token alleen `isLoading` terug. In de runner bleef een eerder true `isAuthenticated` **true** na een expliciet ongeldige hercontrole. Dit is een frontend-statefout, geen aangetoonde omzeiling van serverautorisatie.
5. `syncLikedSets()` verwerkt alleen niet-lege resultaten. Een succesvolle lege favorietenlijst laat dus oude favorieten staan. De Favorites-pagina voegt serveritems bovendien samen met bestaande ids, waardoor verwijderingen van een andere client kunnen blijven hangen. De lokale opslagkey is niet accountgebonden.

**Advies:** één sessiestatus voor het hele scherm, één volledige uitlogactie met engine-/playerreset en accountgebonden cacheopruiming. Laat een succesvolle lege serverlijst bestaande favorieten wissen, maar onderscheid die eerst van een netwerkfout: `getStarred()` retourneert momenteel ook bij fouten `[]`.

**Regressies:** account A → uitloggen → account B; lege favorieten van B; hercontrole met verlopen token; beide bestaande uitlogknoppen. Beoordeel ook of uitloggen een actuele stream moet beëindigen en of servercredentials sessiegebonden gemaakt moeten worden.

#### SOL-07 / SOL-14 — P2: tracklistupdates kunnen de verkeerde actieve cue bepalen

**Bron:** `playerStore.ts:345-365,374-385`; `TracklistSection.tsx:101-118`; `Scrubber.tsx:73-85`.

`setTracklistForSet` controleert wel of de tracklist bij de huidige metadata hoort voordat die metadata wordt vervangen, maar herberekent daarna **altijd** de globale actieve cue op basis van de binnengekomen tracklist.

**Reproductie SOL-07:** B speelt met twee cues. Een late tracklist voor A met drie cues zet B's `activeCueIndex` op 2: buiten B's lijst. De fetch in TracklistSection heeft bovendien geen cleanup-/generatiecontrole; een oud antwoord kan ook de lokale sheetinhoud vervangen.

**Reproductie SOL-14:** op positie 0, met eerste cue op 60 seconden, wordt index 0 geselecteerd door `Math.max(0, lo - 1)`. De scrubber gebruikt elders juist -1 vóór de eerste cue. Er zijn dus meerdere onderling verschillende definities van 'actieve cue'.

**Advies:** één geteste cuezoekfunctie, actuele-setcontrole vóór statewijziging, -1 vóór de eerste cue, en oud cue-/trackliststate resetten bij setwissel. Leg ook vast hoe onbekende of dubbele timestamps behandeld worden.

#### SOL-10 — P1: HTTP-succes wordt verward met Subsonic-succes

**Bron:** `src/services/subsonic.ts:203-223,338-355,383-393`; `playerStore.ts:314-334`; `AudioEngine.ts:83-90`.

De algemene `request()` controleert netjes `subsonic-response.status`. `starAlbum`, `unstarAlbum` en `savePlayQueue` doen dat niet: ze retourneren alleen `res.ok`.

**Reproductie:** een gesimuleerde HTTP 200 met `subsonic-response.status = failed` levert voor alle drie functies **true** op. De optimistic like-update negeert bovendien het resultaat, en de engine werkt na een savepoging de savetime bij zonder het booleanresultaat te controleren.

**Gevolg:** favorieten of luisterpositie kunnen in de interface als verwerkt overkomen terwijl de API de wijziging heeft geweigerd.

**Advies:** gebruik één responsevalidator, met gestructureerd onderscheid tussen transportfout, applicatiefout en geslaagde mutatie. Behandel optimistic updates met rollback of expliciete pending/retry-status. Alleen een succesvolle save mag de succesvolle-saveklok bijwerken.

#### SOL-11 — P2: handgeschreven MD5 verwerkt geen UTF-8-invoer

**Bron:** `subsonic.ts:55-74,197-200,271-274`.

De routine verschuift JavaScript-charcodes rechtstreeks in de MD5-woorden, zonder UTF-8-byteconversie.

**Reproductie:** ASCII-controle komt overeen met Node's MD5 over UTF-8; een synthetisch wachtwoord met `é` niet. Geen echt gebruikerswachtwoord is gebruikt of getest.

**Interpretatie:** aangetoonde afwijking ten opzichte van UTF-8-MD5 en daarmee een authenticatiecompatibiliteitsrisico voor niet-ASCIIwachtwoorden. Het acceptatiegedrag van de actieve server is niet met zo'n account getest.

**Advies:** geen extra zelfgebouwde cryptografische varianten. Gebruik een beproefde compatibele implementatie met expliciete byte-encoding en protocoltestvectoren; behoud het door de API vereiste protocol in plaats van MD5 willekeurig door een ander algoritme te vervangen.

#### SOL-12 — P2: pauzeren slaat dezelfde positie dubbel op

**Bron:** `AudioEngine.ts:183-184,363-367`.

`pause()` roept `savePlaybackPosition()` aan en `onPause()` doet dat opnieuw. Bij pauzeren vanuit een spelende toestand worden dus twee saves gestart.

**Reproductie:** bij positie 42 seconden werden **twee identieke saveopdrachten** geregistreerd. De precieze eventtiming van een browser is gesimuleerd; de dubbele aanroepplaatsen zijn rechtstreeks in de bron aanwezig.

**Advies:** één eigenaar voor opslaan bij pause; serialisatie/coalescing voor periodieke en overgangssaves. Dit vermindert belasting en maakt races rond setwissels beter beheersbaar.

#### SOL-13 — P1: geweigerde eerste play laat loading zonder fout staan

**Bron:** `AudioEngine.ts:332-344`; `playerStore.ts:174-175`.

De eerdere bevinding is nu direct gereproduceerd. Een gesimuleerde geweigerde `audio.play()` uit `loadSet()` wordt alleen gelogd. `loadSet()` retourneert geen afspeelbelofte aan de store die deze weigering kan afhandelen.

**Reproductie:** na de weigering blijft `status = loading`, `error = null`. Dit bewijst het foutafhandelingsgat, niet dat een specifieke iOS-versie altijd zo'n weigering veroorzaakt.

**Advies:** een eenduidige ready/blocked/error-overgang en zichtbare herstelactie. Behoud onderscheid tussen browsertoestemming, netwerkproblemen en onbruikbaar audioformaat.

#### SOL-15 / SOL-16 — P1: service-workerupdate kan oude caches al vernielen vóór installatie slaagt

**Bron:** `public/service-worker.js:3-14,18-23,26-35`.

De eerste review benoemde te brede cacheverwijdering. De tweede review bevestigt bovendien de gevaarlijke volgorde: de **install**-handler verwijdert de vorige cache en caches van andere apps voordat `addAll()` voor de nieuwe versie klaar is.

**Reproductie SOL-15:** met een vorige Crystal-cache en een cache van een andere app, gevolgd door een mislukte nieuwe precache, zijn beide bestaande caches al verwijderd. Ook al faalt de nieuwe installatie, die eerdere verwijderingen zijn dan niet teruggedraaid.

**Reproductie SOL-16:** bij netwerkuitval en een niet-gecachete JS-bundel eindigt de fetch-handler met `undefined` in plaats van een Response. Dit bevestigt het ontbreken van een functionerende appbundelfallback in de huidige worker.

**Advies:** eerst de nieuwe versie volledig installeren; alleen eigen oude caches opruimen tijdens een gecontroleerde activatie; rekening houden met nog actieve oude clients. Alle benodigde versiegebonden assets in een gegenereerde precache, met offline navigatiepad en veilig updateprotocol. Niet simpelweg overal `stale-while-revalidate` op plakken.

### 10.4 Aanvullende statische bevindingen — niet in de 16 reproducerende scenario's meegeteld

#### A. P1 — backend vertrouwt aangeleverde OAuth-client-id te vroeg

**Bron:** `/opt/beatmonkey-core/app/main.py:249-250`; `/opt/beatmonkey-core/app/auth.py:36-56`.

Bij deze gerichte uitbreiding naar de bijbehorende authbron blijkt dat `req.client_id` vóór de serverconfiguratie wordt gekozen. De verifier probeert eerst verificatie tegen die aangeleverde audience. Als die verificatie slaagt, wordt `TRUSTED_CLIENT_IDS` niet meer gecontroleerd; de allowlistcontrole staat alleen in het fallbackpad.

**Risico:** de trust boundary voor toegestane OAuth-clients kan zo door een requestparameter worden bepaald. Een geldig Google-token voor een andere client wordt niet noodzakelijk op basis van de serverallowlist afgewezen. Dit omzeilt niet automatisch de Google-handtekening of de afzonderlijke e-mailwhitelist; er is geen aanval op productie uitgevoerd en de runtime/deployed backend is niet volledig vergeleken.

**Advies:** kies en beperk toegestane audiences uitsluitend server-side, ook bij slagen van de eerste verify-call. Neem deze servervoorwaarde mee wanneer de PWA-login wordt vernieuwd. De eerdere beperking 'servervalidatie niet volledig geaudit' blijft gelden voor alle niet-geïnspecteerde backendpaden.

#### B. P2 — gedeelde song-link kan op de eerste song van het album landen

**Bron:** `src/routes/set.$id.tsx:23-36`; `playerStore.ts:101-107`.

De share-route kan een song-id oplossen naar zijn album, maar draagt vervolgens alleen het album-id over. `loadSet()` kiest altijd `songs[0]`. Voor een album met meerdere songs gaat daarmee het oorspronkelijke song-id verloren. Bij één-song-livesetalbums treedt dit specifieke verschil niet op.

**Advies:** behoud de expliciete songidentiteit door de hele share-/playerketen; maak het onderscheid tussen albumlinks en songlinks onderdeel van het routecontract.

#### C. P2 — dezelfde gedeelde set op een ander tijdstip heropent niet betrouwbaar

**Bron:** `src/routes/set.$id.tsx:14-19,28-30,43`.

De effectdependency en de `started`-guard bevatten alleen het id; de queryparameter `t` wordt pas binnen dat effect gelezen. Wanneer de router dezelfde component voor dezelfde set behoudt en alleen `?t=` verandert, ontbreekt een trigger om die nieuwe positie te verwerken. Een koude volledige paginalaad is iets anders en kan wel werken.

**Advies:** valideer en observeer de zoekparameter via de router, en sleutel het geopende doel op set/song plus timestamp. Test interne navigatie én koude start.

#### D. P2 — bediening en opslagfouten krijgen nog te weinig expliciete behandeling

- `Scrubber.tsx:196-209` declareert een slider maar heeft geen `tabIndex`, toetsenbordhandlers of `aria-valuenow`; de actuele waarde wordt alleen visueel bijgewerkt. Dit is een concrete implementatieleemte; VoiceOvergedrag is niet gemeten. Voorkeur: native range-input of volledig toegankelijke sliderimplementatie.
- `authService.ts:112-113` leest legacy localStorage buiten de eerdere try/catch. Ook `subsonic.ts:172-174` leest browseropslag op moduleniveau. Als die opslag ontoegankelijk is, kan de fout eerder optreden dan de bedoelde fallback. Niet op een fysiek toestel gereproduceerd.
- `TrackRow.tsx:31-50,68-76` behandelt horizontale beweging zonder verticale richtingsdrempel, touchcancel of expliciete klikonderdrukking na swipe. Verkeerde acties bij scrollen zijn een hardware-/interactietestrisico, geen al bewezen iPhone-defect.
- `FullscreenPlayerOverlay.tsx:90-95` en `TracklistSection.tsx:186-191` behandelen afwijzing/annuleren van share of clipboard niet. Voeg consistente fout-/annuleringsafhandeling toe zonder een gewone annulering als ernstige fout te tonen.

### 10.5 Wat uit de eerdere audit overeind blijft — en wat niet als bewezen mag gelden

**Bevestigd en aangescherpt:** herstel zonder audio-src, onvolledige service-workercaching, ongecontroleerde cacheopruiming, laadfout zonder zichtbare foutstate, zwakke assertions in bestaande tests en races rond asynchrone playeracties.

**Nieuw onderbouwd:** identiteitsoverwrite album→song, laat queueantwoord dat een andere set seeked, onvolledige logout-/accountstate, foutpositief succes van Subsonicmutaties, Unicode-MD5-afwijking, foutieve cueherberekening en cacheverlies bij mislukte workerinstallatie.

**Nog géén hardwarebewijs:** achtergrondstilte door Web Audio, OAuth-terugkeer vanuit de beginschermcontainer, safe-area-overlap, toetsenbord-/zoomgedrag en werkelijk energieverbruik. Hiervoor blijven de fysieke tests uit hoofdstuk 7 nodig. De runner simuleert geen Safari, AudioSession, bluetooth of telefoongesprekken.

**Nuance op eventuele oude aanbevelingen:** niet blind een audio-node disconnecten; niet alle oude JS-chunks direct wissen; een async-await is niet op zichzelf bewijs van verloren gebruikersactivatie; bestaande groene tests zijn geen releasegoedkeuring. De eerdere correctie over de root-TypeScriptcheck blijft van kracht.

### 10.6 Bijgestelde aanpak voor de eerstvolgende ontwikkelronde

1. **P1 — identiteit en playertransacties:** afzonderlijke album-/songvelden, generatiegebonden selecties en queue-antwoorden, herstel van bron plus positie, expliciet afspeelfoutpad.
2. **P1 — sessies en accountgrenzen:** één authbron, beide uitlogknoppen samenvoegen, speler en accountgebonden state resetten, lege lijst onderscheiden van netwerkfout; server-side OAuth-audiencebinding controleren.
3. **P1 — persistence en updates:** API-responsvalidator voor mutaties, betrouwbare savecoördinatie, eerst veilige workerinstallatie en daarna gecontroleerde activatie.
4. **P2 — tracklists en delen:** één cuezoekfunctie, late antwoorden negeren, songidentiteit en timestamp in routes behouden; bestaande HTTPS-webfallback realiseren.
5. **iPhone-validatie:** test dezelfde stabiele functionaliteit eerst met gewone HTML-audio en vervolgens met visualisatie; Safari en beginschermmodus afzonderlijk. Pas daarna gerichte platformspecifieke maatregelen kiezen.

De auditrunner is een diagnoseartefact, geen vervanging voor toekomstige regressietests in de projecttestsuite. Vertaal de foutscenario's bij implementatie naar tests die het **gewenste** gedrag verwachten en dus eerst rood zijn op de huidige code.

### 10.7 Controleerbare herkomst

Dynamisch geteste bronbestanden, SHA-256 bij de definitieve run:

- `src/engine/AudioEngine.ts`: `cdd9bf0b4324cfd69be3c37a867f3a5b6852ca9dff2a489a1f2ce322d26f48a7`
- `src/stores/playerStore.ts`: `0c33dfd3777197376a517f4280ee99a3faa1f506082edbb907d69785a9df553a`
- `src/stores/useAuthStore.ts`: `131881c1f0083004657011d4fc5b44a1f2776433922284e086251fecbcc9af59`
- `src/services/subsonic.ts`: `96467269134b11cb6c039ca43d4e923f98ae1dceefd207e798449e6954b5a0ce`
- `public/service-worker.js`: `df2264de261ec8ef492bcf0fd135335afa19e6c57f28b384f5e2a3b5551b2202`

Backup van het document vóór deze toevoeging: `Beatmonkey-Crystal-iOS-onderzoek-en-review-2026-11-05.pre-sol61.md` in dezelfde scratchmap. De oorspronkelijke inhoud had SHA-256 `68002b09b96c7276adf5069524ed9c6433c90347ad2b54c8a419725a0fc0dc00`.

**Eindstatus tweede review:** bevindingen toegevoegd aan ditzelfde document; geen fixes, commit, build of deploy uitgevoerd. De 16 auditreproducties en hun outputs staan in het afzonderlijke bewijsbestand.

