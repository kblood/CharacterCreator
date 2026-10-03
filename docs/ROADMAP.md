# CharacterCreator: roadmap

Dato: 2026-10-02. Status: forslag til ejeren, revideret efter kritisk gennemgang. Intet er postet, pushet, forket eller deployet, og denne fil er ikke committet.
Mærker: **VERIFIED** = læst eller kørt, **INFERRED** = vurdering, **UNKNOWN** = ikke afklaret.
Indsats er angivet i agentdage. Alle estimater er INFERRED. Stier skrives som `<scratch>` (arbejdsmappe uden for repoerne) og `<tools>` (værktøjsmappe), aldrig som maskinstier.

**Kort fortalt.** Kroppen, riggen, klippene og tøj-fittet *er allerede* MPFB-data (VERIFIED: neutral krop 0.0004 mm fra stock `create_human`, `MhcloFit` 0.000 mm fra `fit_clothes_to_human`). "Byg mere direkte på originalen" betyder derfor ikke en omskrivning, men tre ting:
1. Vi koder tingene på standardmåden (MPFB-navne og -kilder, glTF uden private krav).
2. Alt vores eget ligger i navngivne lag, der kan slås fra.
3. Vi bidrager tilbage til MPFB, hvor det passer.

**Cloth i MPFB.** En PR er realistisk, men kun i den form maintaineren selv har efterspurgt (#65, #228): en Python-hjælper, der sætter Blenders egen Cloth op med en pin-gruppe (arbejdsnavn `mhmask-cloth-pin`), en collision-proxy og fornuftige presets. Vores JS-XPBD-solver bliver ikke en del af MPFB. Den forbliver vores runtime (GPL-3.0-or-later siden 2026-10-03), som læser den samme pin-gruppe. Den første upstream-PR bør være et lille alpha-fix, så der er tillid, før cloth-forslaget kommer.

---

## 1. Hvad vi vil have til at virke

Hver accept kan tjekkes med et script eller en tælling. Billeder produceres kun som materiale til Luna (GPT 6 Luna via Codex) og ejeren. Ingen agent-accept afhænger af, at en agent kigger på billeder.

1. **Vanilla MPFB som nulpunkt.** Med alle vores lag slået fra (`--profile vanilla`) giver buildet en krop, der ligger ≤ 0.1 mm fra MPFB på de 11 enkelt-macro-valideringskroppe og ikke er dårligere end Originalens målte tal på de 3 blandede (mix 10.2 mm, male_tall_heavy 0.1 mm, female_old_short 8.8 mm). Hvert lag kan derefter slås til enkeltvis, og en node-test pr. lag viser, at karakteren stadig loader.
   - Bemærk: dette kræver MPFB's `$md`-model i vanilla-profilen. Vores nuværende lineære model ligger på 47.7 mm (mix), så målet hænger sammen med M8.
2. **Ét format til alle hosts.** "Standard"-profilen har 0 entries i `extensionsRequired` og 0 validator-fejl. Den samme fil loader i CC-vieweren, compare-siden, XR-demoen og headless i den første native engine, som ejeren vælger (beslutning 12). Hver host tjekker 53 knogler, morph-navne og -antal samt 12 klip.
3. **Én runtime, ingen kopier.** CC-viewer, XR og compare-siden importerer det samme `character-system/` via en git-mappe, der er pinnet til et tag (submodule eller subtree). XR's `avatar.js` er på ca. 100 linjer eller mindre (kontrakt §9.2). `sync_assets.mjs`, `sync_ours.mjs`, `main_constants.json` og alle host-kopier af `BREAST_SUPPORT` er væk.
4. **Tøjpakker fra fremmede.** En CC0 `.mhclo`-pack lavet i MakeClothes kan bygges uden kodeændringer. Testsættet er shoes02, female_sportsuit01, male_worksuit01 og fedora01. Core-tøjets GLB'er er sha256-identiske før og efter (forudsætter, at buildet først er bevist deterministisk, se M2), og `check_garment` og cloth-integritetsmatricen bliver ikke dårligere.
5. **Vores tilføjelser er dokumenterede, valgfrie lag.** Det gælder cloth, breastPhysics, eyeLife, skin-, hair- og cornea-shaders, jointsFollow, correctives, outfitRules og zoneHiding (de 10 `EXTRA_TOGGLES` i compare-siden). Lag med data ligger i en `CC_*`-extension med JSON-schema eller i en `.target`-fil. Rene runtime-lag (shaders, eyeLife) er flag i `character-system/`. Ingen af dem står i `extensionsRequired`, og data-lagene overlever glTF-Transform, når de er registreret.
6. **Beslutninger står på tal.** `docs/DECISIONS.md` har én dom pr. lag og pr. morph-model: keep, drop, optional eller undecided. Hver dom citerer et målt tal (mm, ms/frame eller MB) og eventuelt et Luna-review.
7. **MPFB-bidrag klar til et ja.** I en lokal mpfb2-klon under `<scratch>` ligger to branches: et alpha-fix og en cloth-hjælper. Begge har grønne tests fra source og et engelsk issue/PR-udkast. Vores JS-runtime kan simulere et asset, der har en `mhmask-cloth-pin`-gruppe, med default-parametre.
8. **Sikker drift.** Kun ét script kan deploye til `webxr/charactercreator`. Rollback er afprøvet (dry-run). CI-workflows ligger klar lokalt, og det offentlige repo indeholder ingen maskinstier.

---

## 2. Hvad vi har lært

### Krop, rig og klip (spike morphs-rig: *feasible_with_work*)
- **VERIFIED:** Vores krop ER MPFB's HumanService-output. Den neutrale krop afviger 0.0004 mm fra stock `create_human`. Riggen er standard `game_engine` med 53 knogler, identiske navne og samme rækkefølge.
- **VERIFIED:** 50 af de 92 morphs er direkte MPFB/MakeHuman-data: 16 macro, 26 face, 2 blink og 6 bdet. Afvigelsen er højst 0.026 mm, hvilket er int16-støj. 32 `corr_*` er afledt af MPFB-samples. Kun de 10 `look_*` og `dyn_breast_*` er rent private.
- **VERIFIED:** Vores lineære macro-model er mindre præcis end MPFB's `$md`-model. På de samme 14 kroppe ligger "mix" på 47.7 mm hos os mod 10.2 mm i Original. Værste tilfældige krop er 105 mm, median 19 mm. **INFERRED:** De værste tal kommer fra fuld `height_tall`, som UI'et ikke kan nå, fordi det er cappet til 0.45.
- **VERIFIED:** På de 11 enkelt-macro-kroppe ligger vi ca. 7-7.8 mm fra MPFB mod 0-0.1 mm i Original. **INFERRED:** Årsagen er vores `breastGate`, altså et designvalg.
- **VERIFIED:** `dyn_breast_*` kan leveres som almindelige `.target`-filer med 0.000 mm roundtrip-afvigelse.
- **VERIFIED:** Refit-workaroundet i `build_base.py` (`reposition_edit_bone`, linje 450-455) er en no-op på MPFB 2.0.17 / Blender 5.2: 0.000 mm i 4 scenarier. Det er altså ikke en upstream-bug. **UNKNOWN:** om fejlen opstår med alle 92 keys, så den erstattes af en assert, ikke slettes.
- **VERIFIED:** De 12 klip er ens på stock-riggen, højst 0.21 grader fra hinanden.
- **VERIFIED (header læst):** Baselines `web/baseline_viewer/macros.js` (115 linjer, 1 commit) siger selv, at den er skrevet ud fra MakeHumans CC0 `macro.json` og den dokumenterede regel, ikke fra MPFB-kilden. **UNKNOWN:** om det holder ved en sammenligning med MPFB's kode. Den skal tjekkes, før den flyttes ind i det offentlige MIT-repo. (Repoerne er GPL-3.0-or-later siden 2026-10-03; se punkt 3.4.)

### Tøj (spike clothing-standard: *feasible_with_work*)
- **VERIFIED:** Vores `MhcloFit` og MPFB's `fit_clothes_to_human` giver identiske resultater (0.000 mm på 22 kroppe × 3 garments). Vores tøj er altså allerede "MPFB-fit + bagte morphs".
- **VERIFIED:** Rent MPFB-fit giver hudgennemtrængning over 1 mm på 14 af 22 kroppe og lagkrydsninger på op til 26.1 mm. Med vores clearance-lag er der 0 lagkrydsninger. Clearance skal derfor beholdes, men som et lag.
- **VERIFIED:** Surface Deform (Original B) ligger 7-52 mm fra MPFB, selv ubagt. Det er en dårlig tøjrute.
- **VERIFIED:** Den største reelle afvigelse fra MPFB i vores tøj kommer fra kroppens macro-model, ikke fra tøjet.
- **VERIFIED:** Community-packs er ikke drop-in i dag. fedora01 fejler, fordi mhmat-navnet antages at være `<pack>.mhmat`. female_sportsuit01 bliver tolket som "top". Når en pack tilføjes, ændrer core-jeans, jakke og frakke bytes.
- **VERIFIED:** `.mhclo` har ingen felter for slot, occupies, conflicts eller pin. `z_depth` bliver parset, men MPFB bruger den ikke. Ukendte nøgler ignoreres stille.

### Eksport og extensions (spike export-extension: *feasible*)
- **VERIFIED:** Alle Original-materialer er BLEND. MPFB's GameEngine-wrapper kobler altid Alpha (`nodewrappergameengine.py:152/158`), og `.mhmat`-nøglerne `transparent` og `alphaToCoverage` (`mhmatkeys.py:76-77`) læses aldrig. Rettelsen er prototypet: hud og tøj bliver OPAQUE, bryn, vipper og hår bliver MASK, og validatoren melder 0 fejl. Risiko: øjnene bliver MASK, så cornea-gennemsigtighed forsvinder.
- **VERIFIED:** Alle 24 CC-GLB'er og 36 Original-GLB'er har 0 validator-fejl. Fælles advarsler: `NODE_SKINNED_MESH_NON_ROOT` og `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE`.
- **VERIFIED:** `CC_cloth`, `CC_garment`, `CC_material_tint` og `CC_jiggle` gav 0 schema-fejl, 0 validator-fejl og 0 parameter-mismatch. Uden registrering i glTF-Transform forsvinder de stille, og et `ccMask`-index kommer til at dingle.
- **VERIFIED:** Standardprofilen (dequantized) gør `base_body` 62 % større, fra 7.26 til 11.79 MB.
- **VERIFIED:** Med WebP (q85) og et cap på 2048 falder Original A fra 120.9 til 25.1 MB og B fra 161.6 til 65.8 MB. Deling af teksturer sparer kun 8.8 MB. Kun størrelser er målt, ikke billedkvalitet.
- **VERIFIED:** VRMC_springBone kan ikke erstatte `CC_jiggle` 1:1, fordi den driver knogler i stedet for morphs og ikke har frekvens eller dæmpning.

### Cloth til MPFB (spike mpfb-cloth-pr: *feasible_with_work*)
- **VERIFIED:** Maintaineren har selv skrevet, hvad MPFB kan bidrage med. I #65: "help with enabling [Blender cloth] with sensible defaults". Hans egen ønskeliste #228 nævner default cloth modifier, collision på kroppen og pin groups.
- **VERIFIED:** `mhmask-`-vertexgrupper behandles allerede særskilt i MPFB (`rigservice.py`, og `clothesservice.py:443` interpolerer dem til tøj). En pin-gruppe kræver derfor ingen formatændring.
- **VERIFIED:** Prototypen med Blender Cloth på skørtet fra female_elegantsuit01 og walk-klippet gav 0 NaN og 0 frie vertices mere end 1 mm inde i kroppen. Stræk p99 er 1.65-1.97, og simuleringen er ikke periodisk: loop-til-loop-afvigelsen er 97-180 mm. Bake til shape keys virker (345 KB GLB). Kun ét garment, ét klip og én krop er testet.
- **VERIFIED:** I #381 anbefaler maintaineren native filer frem for glTF. En glTF-cloth-extension som MPFB-feature har derfor lav chance.
- **INFERRED:** At lægge selve JS-solveren ind eller lave en Python-port af den vil blive afvist.
- **VERIFIED:** CONTRIBUTING siger "simply make a pull request". Kode antages at være GPL, og der er ingen CLA. **UNKNOWN:** MPFB's politik for AI-genereret kode og maintainerens svartid (62 åbne issues).
- **VERIFIED:** Ejeren er eneforfatter af CC (37 commits), og `web/cloth/` importerer ingen tredjepartskode. Han må derfor selv bidrage sin egen kode under GPL-3.0-or-later.

### Hosts og drift
- **VERIFIED:** Der findes tre kopier af assembly-glue: CC `web/main.js` (820 linjer), XR `src/avatar.js` (443) og Baseline `web/compare/adapters/ours.js` (986). De er allerede drevet fra hinanden: XR's `BREAST_SUPPORT` (avatar.js:23) mangler `dress: 0.25` og `jacket: 0.2`, som CC `main.js:741` har.
- **VERIFIED:** XR er kun testet i emulering (IWER). Intet har kørt på et rigtigt headset.
- **VERIFIED:** `CharacterCreator\deploy.ps1` (git-ignored) har default `$Name = 'charactercreator'` (linje 31). En kørsel ville overskrive compare-sitet og slette den eneste backup. CC's AGENTS.md beskriver den stadig som den normale deploy.
- **VERIFIED:** `.glb` serveres uden Content-Type, cache og gzip. `.htaccess` ligger på serveren, men har ingen effekt (**INFERRED:** AllowOverride None).
- **VERIFIED:** Ingen af repoerne har CI, og CC har ingen root-`package.json`. Det offentlige CC-repo har 8 trackede linjer med værktøjs-maskinstier (`.gitignore`, `README.md`, `docs/BLENDER_WORKFLOW.md`, `docs/STATUS.md`).
- **VERIFIED (2026-10-02, `git branch -vv`):** Branch-forvekslingen er sket igen. `ec23ed7` (export-extension-spiken) ligger på `spike/clothing-standard`, og `spike/export-extension` peger på master `d3883eb`. Det er tredje gang, at den delte Baseline-arbejdsmappe har givet forkerte branches. `spikes/morphs-rig/` og `spikes/mpfb-cloth-pr/` ligger desuden som untracked kopier i arbejdsmappen.
- **VERIFIED:** Integritetsmatricens tal i STATUS.md er målt på det næstsidste build. Det endelige build er ikke kørt fuldt igennem.
- **UNKNOWN:** Om Godot, Unity og Unreal kan læse `KHR_mesh_quantization`, sparse morphs og `CC_*`.

### Kendte fejl, der skal med i planen (VERIFIED fra STATUS.md og facts)
- Rød test: "long coat over T-shirt + jeans, female" er kaotisk. Støj på ±1e-7 m vender resultatet, og 4 af 8 perturbationer består.
- Dress + trenchcoat i crouch: hud gennem skørtet og skarpe spidser. Parret er i CONFLICTS, så det kan kun nås ved at tvinge det.
- Et lille rødt fragment under kæben med jakke (måske mundens indre). En fix er kun tjekket i scratch-builds.
- Et trin i dress-skørtet ved hofterne med cloth on, mest på mandlige kroppe. Årsag ukendt.
- Hår ved krave og hætte: håret er statisk og kun skinned til 6 knogler.
- Bra under dress/jacket i idle_fidget (3 v / 29.9 mm). Fingerspidser gennem frakkens side i walk. Coat:jeans i neutral jump (5 v / 7.4 mm).
- `base_body_anim.glb` mangler `_CCZONE`, så skjult-hud-zoner forsvinder i animations-GLB'en.
- Tøj har ingen morph-normals, så skyggen over brystet er flad.

---

## 3. Principper

1. **Standard først.** Følgende er STANDARD og bruges som de er: MPFB-basemesh, `game_engine`-rig og -vægte, MakeHuman-targets, `.mhclo`/`.mhmat` + MPFB-fit, `delete_verts`, glTF 2.0 core og Khronos-extensions.
2. **Alt vores eget er et navngivet, valgfrit lag.** Det gælder clearance, zones/hide_lower, genereret tøj, cloth (`CC_cloth` + `_CLOTH_PIN`), brystfysik (`CC_jiggle` + `dyn_breast_*`), outfit-regler (`CC_garment`), tint (`CC_material_tint`), shaders, joints-follow, correctives og look-morphs.
   - Hvert lag kan slås fra, og karakteren virker stadig.
   - Intet lag må stå i `extensionsRequired`.
   - Hvert lag har en dom i DECISIONS.md.
3. **Plugin = karaktersystemet.** `character-system/` er produktet. XR og compare-siden er demo-hosts. Native hosts (Unity, Godot, Unreal) er førsteklasses mål, men bevises med én engine ad gangen. Distribution sker som en mappe i git.
4. **Licensregel** (ikke juridisk rådgivning).
   - CC, XR og Baseline er GPL-3.0-or-later (besluttet af ejeren 2026-10-03, beslutning 17). Tidligere commits og kopier modtaget under MIT forbliver MIT for dem, der fik dem. Grund: pluginet er ikke tænkt til lukkede spil, og GPL matcher MPFB (GPL-3.0-or-later).
   - Kode kan derfor gå begge veje mellem vores repos og MPFB, når ophavsrets- og licensnoter følger med. Kopieret kode krediteres (projekt, fil, version), og der kopieres ikke fra en fork uden at tjekke forkens licens og forfattere.
   - MPFB-bidrag skrives stadig som ny Python i en separat klon under `<scratch>`, uden for vores repos.
   - Vores build-scripts kalder MPFB's API i Blender, men distribuerer ikke MPFB (LICENSE-NOTES.md).
   - Konsekvens: lukkede spil der indlæser pluginet skal selv være GPL-kompatible.
   - Om AI-assistance oplyses upstream, er ejerens beslutning (nr. 4). Anbefalingen er ja.
   - **Grænseregel (ejerens afklaring; nu en ARKITEKTURREGEL, ikke en licensnødvendighed):** karaktersystemet er et selvstændigt plugin, som værter (web og spilmotorer) indlæser. MPFB er et byggeværktøj, der kører i Blender og kun afleverer **data** (GLB, targets, tøj, materialer). Data går frit over grænsen. **Ingen MPFB-kode (og intet afledt af den) ligger i runtime eller i pluginet**, så pluginet forbliver uafhængigt af Blender og MPFB. Da alt nu er GPL-3.0-or-later, er reglen ikke længere nødvendig af licensgrunde. Det eneste kendte sted med MPFB-afledt logik i runtime er makrovægtformlen (`macros.js`). Clean-room-omskrivningen (M3b) er **ikke længere påkrævet af licensgrunde**; resultatet må stadig bruges. Bruges MPFB-afledt kode, krediteres MPFB. Byggescripts i Blender må kalde MPFB.
5. **Intet offentligt uden ejerens ja pr. handling.** Det gælder fork, push, issue, kommentar, PR, Khronos-prefix og deploy. Agenter laver kun kladder og lokale branches.
6. **Ingen screenshot-review af Opus.** Agenter producerer billeder og måler numerisk. Visuelle domme laves af Luna og ejeren. Accept for et agent-trin er altid numerisk. Et visuelt review er en separat gate før deploy eller dom.
7. **Én worktree pr. agent.** Ingen `checkout` i en delt mappe, aldrig `git add -A`, og ingen ændringer i andre agenters mapper.
8. **Før/efter på samme maskine.** Integritetsmatricen er kaotisk og tager 30-60 min, så regressioner måles mod en gemt baseline, kørt i baggrunden med log.

---

## 4. Faser og milepæle

**Valg truffet ved sammenfletningen af de tre planer:**
- **Rækkefølge.** Sikkerhedsnettet kommer først, fordi det er billigt, og fordi branch-rodet er VERIFIED og sker nu. Derefter kører beslutningstavlen og alpha-fixet parallelt.
- **Macro-model (`$md`).** En målt gate med tre modeller, herunder den billigere mulighed "flere correctives", som ingen har målt. Gaten ligger nu **før** runtime- og extension-arbejdet (M9, M10), fordi en ombasering ændrer morph-navne og -indekser, som de bygger på.
- **Cloth-PR-kode før eller efter maintainerens svar.** Kompromis: tuning, issue-udkast og en lille kerne før svaret. UI, operatorer, presets og bake poleres først efter svaret.
- **Den kaotiske coat-test.** Den omskrives til en statistisk assertion over faste perturbationer. Den skippes ikke, og vi tuner ikke solveren for at få den grøn.

### Fase 0: Sikkerhedsnet (ca. 3-4 dage)

**M0: Worktrees og oprydning af branches** (0.25-0.5 dag, kræver beslutning 1)
- Accept:
  - Backup-tags på alle spike-SHA'er (6b7f097, 4ce8d4e, ec23ed7, 6d359cc, c9564ae, CC 351d801), før en ref flyttes. `git rev-parse` på hvert tag lykkes.
  - `ec23ed7` ligger på `spike/export-extension`, og `spike/clothing-standard` peger på `4ce8d4e`.
  - For hver spike-branch gælder, at `git diff --name-only master..<branch>` kun indeholder `spikes/<eget-navn>/`.
  - De untracked kopier i Baseline-arbejdsmappen fjernes først, når `git diff --no-index` mod den committede version er tom.
  - AGENTS.md i alle tre repos beskriver worktree-reglen med `<scratch>` som pladsholder.
  - CC's `spike/clothing-standard` er omdøbt til `spike/clothing-standard-cc` for at undgå navneforveksling.

**M1: Deploy-sikkerhed** (0.5 dag, ingen afhængigheder)
- Accept:
  - `CharacterCreator\deploy.ps1` nægter målet `charactercreator`. Verificeres med `-DryRun` via PowerShell-værktøjet (ikke Git Bash). Da scriptet er git-ignored, står reglen også i CC's AGENTS.md, som peger på Baselines deploy-script.
  - Baselines `-Rollback -DryRun` og `-VerifyOnly` er kørt, og output er gemt.
  - En vhost-snippet (AddType `model/gltf-binary`, DEFLATE, Cache-Control) ligger som tekst til ejeren.
  - Efter ejerens serverændring viser en HEAD-request på en `.glb` `Content-Type: model/gltf-binary` og `Content-Encoding: gzip`, og `-VerifyOnly` giver exit 0.

**M2: Test, CI, hygiejne og målt baseline** (1.5-2 dage, afhænger af M0)
- Accept:
  - Root-`package.json` med `npm test` i CC.
  - Coat-testen er omskrevet: den kører de 8 faste perturbationer og asserter en grænse, som ejeren vælger (beslutning 3). Testen er deterministisk, så den skal give samme resultat ved gentagelse.
  - `.github/workflows/test.yml` ligger på en lokal branch i CC og XR og er ikke pushet.
  - `git grep -n -I -i -E "[A-Z]:\\\\(tools|users)"` i CC giver 0 hits. Stierne erstattes af `<blender>` og `<scratch>`.
  - `COLOR_0.r` er rettet til `_CLOTH_PIN` i PLUGIN_CONTRACT (linje 367) og CLOTH_SOLVER_REPORT.
  - XR README (tøjrækken) og kontraktens linjetal er opdateret.
  - **Determinisme:** to builds af samme commit giver sha256-identiske GLB'er. Ellers dokumenteres, hvilke bytes der varierer. Det er en forudsætning for M11's sha256-accept.
  - Baseline-målinger på det *endelige* build gemt som JSON: fuld integritetsmatrix (default, moves, land; i baggrunden med log), `check_garment`, testtal og GLB-størrelser.

**M2b: Kendte visuelle fejl som numeriske probes** (1 dag, afhænger af M2)
- Formål: fejl, Luna har set, skal kunne genfindes uden billeder.
- Accept (et script, der skriver JSON med tal pr. sag):
  - Rødt fragment under kæben: antal teeth-, tongue- og jakke-vertices uden for hudens overflade i kæbe- og halszonen, på 7 kroppe. Målet er 0.
  - Dress + trenchcoat crouch: `resolveOutfit` kan ikke give parret (test). Den tvungne sag måles med penetration (vertices og mm) og kantstræk.
  - Dress-skørtets trin ved hofterne: maksimal normalvinkel og højdespring langs hofteringen, cloth on og off, mand og kvinde.
  - Hår mod krave og hætte: antal hår-vertices inde i krave og hætte pr. hår × jakke/hoodie/frakke i idle og walk.
  - Bra under dress/jacket i idle_fidget, fingre gennem frakken i walk og coat:jeans i jump: eksisterende tal fra integritetsmatricen gemmes som baseline.
  - `base_body_anim.glb` har `_CCZONE` (test, der fejler i dag).
  - Billeder af samme sager produceres til Luna, men indgår ikke i accept.

**M3: Licens-provenance** (0.25 dag, afhænger af M0)
- Accept:
  - `PROVENANCE.md` for `macros.js` bekræfter eller afkræfter headerens påstand ("skrevet ud fra CC0 `macro.json`"). Metoden er en side-om-side-sammenligning af struktur og navne mod MPFB's macro-kode. Ved tvivl: en clean-room-omskrivning ud fra data og dokumentation.
  - CC `LICENSE-NOTES.md` har et afsnit "Contributing to GPL projects".
  - Et no-GPL-paste-tjek (sortliste over MPFB-specifikke identifikatorer og kommentarer) kører i CI.

### Fase 1: Billige standard-gevinster og beslutningsgrundlag (ca. 4-5.5 dage, kan køre parallelt)

**M4: Beslutningstavle på compare-siden** (1-1.5 dag, afhænger af M0 og M2b)
- Accept:
  - `docs/DECISIONS.json` og en genereret `.md` med de 10 extras + macroModel + breastGate + 53/55 knogler. Hver post har status og et målt tal med kildefil.
  - En node-test viser, at alle ids findes i både `EXTRA_TOGGLES` og DECISIONS.
  - Compare-siden viser status ved hver toggle (node-test på den genererede HTML/JSON).
  - Billeder produceres til Luna. Dommene er ejerens.

**M5: Billig standard-tilpasning** (1-1.5 dag, afhænger af M0 og M2)
- Accept:
  - En `mpfbSource`-mapping for alle 92 morphs: 50 peger på en MPFB-target-sti eller macro-værdi, 32 er markeret `derived` med deres to kilder, og 10 er markeret `private`.
  - Golden-test `MhcloFit` mod `fit_clothes_to_human` ≤ 1e-6 m (headless, under 2 min).
  - Refit-blokken i `build_base.py` er erstattet af en assert (bind == stock fit < 1e-4 m), og `base_body.joints.json` er numerisk uændret (≤ 1e-6 m).
  - `dyn_breast_*.target.gz` genereres med 0.000 mm roundtrip-afvigelse.
  - Valgfrit standardlag: MPFB's `eye-left|right-opened-up` expression units som morphs, så op-blik-clampen på 8 grader kan hæves. Accept: morphs findes og er ≤ 0.03 mm fra MPFB.

**M6: Alpha-fix i Original + WebP-teksturer** (1-1.5 dag, afhænger af M0 og M2; deploy afhænger af M1)
- Accept (numerisk):
  - `build_baseline.py` sætter alphaMode og doubleSided ud fra `.mhmat` (`transparent`, `alphaToCoverage`, `backfaceCull`). Øjnene holdes som BLEND, da Original har ét øje-materiale.
  - En JSON-tælling viser hud og tøj OPAQUE, bryn, vipper og hår MASK og øjne BLEND.
  - Validatoren melder 0 fejl.
  - Workaroundet fra `c6cf2b4` ligger bag et flag.
  - Ingen tekstur er over 2048 px.
  - Normal maps: middel vinkelfejl mod PNG-originalen er målt pr. kort (grader), og alpha-kort: dækningsgrad før og efter ROUND er målt. Tallene bruges som input til Lunas review.
  - Sitets størrelse er rapporteret for de varianter, ejeren kan vælge mellem i beslutning 8. Med kun B og uden /classic/ forventes ca. 95 MB (INFERRED: 65.8 MB B + 28.1 MiB ours).
- Gate før deploy (ikke agent-accept): Luna-review før/efter og ejerens go.

**M7a: Upstream-PR-kladde nr. 1, alpha fra .mhmat** (1 dag, afhænger af M3)
- Accept:
  - mpfb2 er klonet (kun fetch, intet remote til en fork) til `<scratch>/mpfb2` på branch `fix/gameengine-mhmat-alpha` (ca. 10-30 linjer i `nodewrappergameengine.py`).
  - MPFB-testsuiten kører fra source med 0 nye fejl.
  - En ny pytest asserter, at der ikke er et Alpha-link, når `transparent False`, og at der er en ROUND-node, når `alphaToCoverage`.
  - Engelsk issue/PR-udkast med testtal og eventuel oplysning om AI-assistance (beslutning 4).
  - Kører testsuiten ikke inden 0.5 dag (fx på grund af symlink-krav på Windows), stoppes der, og det rapporteres som en blocker.
- Hvorfor først: lille, ægte bug med høj sandsynlighed for accept, og den opbygger tillid før cloth-forslaget.

### Fase 2: Cloth til MPFB (ca. 3.5-4 dage før svar + 2-4 dage efter, parallelt med fase 3)

**M7b-1: Tuning-spike og issue-udkast** (1.5 dag, afhænger af M3 og mpfb2-klonen fra M7a)
- Accept:
  - Testmatrix kun med stock CC0-assets fra MakeHuman system-packen (ikke vores genererede coat- og dress-skørter): skørtet fra female_elegantsuit01 plus 1-2 andre hængende stykker tøj, som agenten vælger og navngiver × walk, run og idle × 2 kroppe. Kørt i baggrunden med log.
  - Mål: stræk p99 ≤ 1.5 og loop-søm p95 ≤ 10 mm med loop-blend, eller en ærlig negativ konklusion.
  - Beslutningsregel: lykkes målet, tilbydes bake som feature. Ellers kaldes det "preview / non-looping".
  - `ISSUE_DRAFT.md` (kommentar på #228 eller nyt issue, beslutning 13b) indeholder de målte tal og 2-3 spørgsmål: gruppenavn, UI-placering og om bake hører hjemme i MPFB.

**M7b-2: Lille kerne i mpfb2-klonen, før svar** (1.5 dag, afhænger af M7b-1)
- Accept:
  - Branch `feature/cloth-helper` med `ClothSimService`: `pin_group_from_bone_heights`, `pin_group_from_body_distance`, `make_collision_proxy` og `add_cloth_modifier`.
  - pytest med `better_socks_low.mhclo` (findes i MPFB's testdata ifølge spiken) viser, at pin-gruppen findes med vægte i [0, 1], at proxyen har alle 13380 body-vertices og ingen Delete-maske, og at et 10-frame-step ikke giver NaN.
  - Koden er ny Python. Den skal ikke indeholde oversat JS fra `web/cloth/` (et diff-tjek viser 0 fælles linjer), så det er tydeligt, at bidraget er en Blender-hjælper og ikke vores solver.
  - Gruppenavnet er én konstant, så det kan ændres, hvis maintaineren ønsker et andet navn.

**M7b-3: Fuld PR efter maintainerens svar og ejerens go** (2-4 dage + review-runder)
- Indhold: operatorer under Operations, CC0-presets som JSON, `bake_frames_to_shape_keys`, valgfri `reweight_free_part` og en docs-side.
- Accept: 0 nye fejl i testsuiten. `git remote -v` viser kun upstream som fetch. Pushet foretages af ejeren.

**M7c: CC læser `mhmask-cloth-pin`** (0.5-1 dag, afhænger af M7b-2 for navnet, ikke af svaret)
- Accept:
  - `cc_clothing.py` bruger gruppen som `_CLOTH_PIN`, når den findes på et asset, og ellers vores egen generator.
  - Test: et testasset, hvor gruppen er skrevet af vores egen kode, giver `_CLOTH_PIN` lig gruppens vægte (maks. afvigelse ≤ 1e-6). Vi importerer ikke GPL-hjælperen fra klonen.
  - JS-solveren kører 600 frames på assettet uden NaN med default `ccCloth`-parametre.
  - Integritetsmatricen er ikke dårligere end M2-baseline.

### Fase 3: Ét format og én runtime (ca. 9-12 dage)

**M8: Morph-model-gate** (1.5-2 dage, afhænger af M3, M4 og M5; skal afsluttes før M10 og før M9's slider-del låses)
- Accept:
  - Tre modeller sammenlignes:
    - (i) som i dag
    - (ii) i dag + ekstra correctives (height×weight, height×gender, gender×age×weight)
    - (iii) `$md` + vægtformel, enten den provenance-tjekkede `macros.js` eller en clean-room-version
  - Målinger på de 14 valideringskroppe og 200 tilfældige kroppe inden for UI-rækkevidde (height ≤ 0.45): median, p95 og max i mm, med og uden breastGate.
  - Fuld pakkestørrelse for (iii) mod de nuværende 27.1 MB.
  - Morph-shader-pris i ms/frame i headless Chrome (ikke repræsentativt for Quest, mærkes sådan).
  - Et beslutningsnotat på 1 side.
- Hvis (iii) vælges, følger **M8b: Ombasering** (3-6 dage):
  - Kun `$md` i vanilla-profilen, med tallene fra mål 1.
  - Lag-keys med kilde.
  - Joints-sidecar pr. key.
  - Alias-map for de gamle 92 navne.
  - Genbagning af alt og ny integritetsmatrix.

**M9: Ét plugin-entry, `character-system/`** (4-6 dage, afhænger af M2; slider-modellen bag et interface, så M8 kan skifte den)
- Trin a, kan laves straks: `breastSupport` pr. item i `clothing.json`, og alle tre hosts læser den. Test: female + dress giver 0.25 i XR.
- Accept:
  - `createCharacterSystem`/`createCharacter` efter kontrakten §5. Opdateringsrækkefølgen fra §5.1 er testet.
  - DOM-fri kerne. Tøj-UI'et er flyttet ud af `createClothing()`.
  - XR `avatar.js` ≤ ca. 100 linjer og ingen import fra `internal/`.
  - 0 "`// from main.js`"-markører.
  - Sync-scripts er erstattet af en lokal git-mappe (submodule eller subtree, beslutning 9), pinnet til et lokalt tag.
  - Paritets-snapshot ≤ 1e-6 før og efter.
  - XR har 94 tests og 38/38 IWER-checks grønne. Compare-sidens `npm test` er grøn.

**M10: `CC_*`-extensions + standardprofil** (2.5-4 dage, afhænger af M5, M8 og M9)
- Accept:
  - `CC_*` skrives kun i `extensionsUsed`, med legacy-extras parallelt i én version.
  - Readers foretrækker `CC_*`.
  - 0 ajv- og validator-fejl.
  - `npm run export:standard` giver tom `extensionsRequired`.
  - glTF-Transform-roundtrip med registrerede extensions bevarer 4/4 testfiler.
  - Zone-bits er erstattet af navne. Test: et nyt garment indsat midt i listen ændrer ikke andres zoner.
  - `body_colliders.json` er erstattet af collider-sets i `CC_cloth`.
  - Joints-sidecaren bæres som en dokumenteret extension på skin (eller som en versioneret sidecar med schema, hvis M12 viser, at engines ikke kan læse extensions).

### Fase 4: Community-packs og native (ca. 5-7 dage)

**M11: Tøjkerne + community-packs** (3-5 dage, afhænger af M2-determinisme, M5 og M10)
- Accept:
  - `cc_clothing.py` er delt i en kerne og navngivne lag.
  - Vanilla-tøj matcher MPFB-fit ≤ 1e-6 m.
  - Materialenavn læses fra `.mhclo`'s `material`-linje, og `keep:null` er default.
  - Slot og occupies læses fra tags eller `pack.json` (med schema, beslutning 11). Ny hat-slot.
  - Core-tøjets clearance beregnes uafhængigt af tredjepartstøj: nye packs fittes kun over core.
  - De 4 community-assets giver exit 0, og core-GLB'er er sha256-identiske før og efter.
  - `PACKS.md` uden maskinstier.

**M12: Native loader-spike** (1.5-2 dage, afhænger af beslutning 12; kan startes før M10 mod de nuværende filer)
- Accept:
  - Headless load af web-profil (quantized) og en dequantized fil: 53 knogler, morphs, 12 klip og 2 s walk. Resultatet (lykkes/fejler pr. fil) styrer M10's standardprofil.
  - `gender_female=1` ligger inden for 0.1 mm af three.js på 10 udvalgte vertices.
  - Konklusion: kan enginens glTF-importer se `CC_*`?
  - Anbefaling med tal om joints-follow og cloth-port.
  - Billeder til Luna (ikke accept).
- Kun hvis spiken er positiv: **M13 native minimum** (3-4 dage): sliders, klip og joint-follow i enginens sprog, statisk tøj og ingen cloth.

**Senere:** ARKit-alias-tabel for ansigts-morphs ud fra MPFB's `faceservice.py` (1-1.5 dag). Hårfysik og eye/face tracking først efter test på rigtig hardware.

**Samlet (INFERRED):** ca. 26-36 agentdage uden M8b-ombasering (+3-6), M13 (+3-4), Rust-kerne og upstream-kalendertid. M9 er det mest usikre estimat, fordi tre hosts refaktoreres på én gang.

---

## 5. Det vi ikke gør

- Ingen JS-solver i MPFB og ingen Python-port af XPBD. Maintaineren peger på Blenders egen cloth (#65).
- Ingen glTF-cloth-extension som MPFB-feature (#381). `CC_cloth` forbliver vores.
- Ingen ændring af `.mhclo`-formatet. `mhmask-`-grupper og tags dækker behovet.
- Ingen PR om et "forældet from-mix-snapshot". Fejlen kunne ikke genskabes.
- Ingen Surface Deform-tøjrute og intet rent MPFB-fit uden clearance-laget.
- Ingen fuld `$md`-ombasering før M8-gaten.
- Ingen Rust-kerne, C-ABI eller tre engine-adaptere, før én engine er bevist.
- VRMC_springBone erstatter ikke `CC_jiggle`. Ingen 55-knogle-rig uden ejerens dom.
- Genereret tøj (coat-skørt, hætte, undertøj) laves ikke om til MakeClothes-assets i denne plan.
- Ingen KTX2 uden måling, ingen tekstur-deling via URI og ingen registrering af Khronos-prefix.
- Ingen nye XR-features (face/eye tracking, hårfysik), før der er testet på rigtig hardware.
- Vi tuner ikke solveren for at få coat-testen grøn.
- Ingen deploy, push, fork, posting eller merge til master fra agenter.

---

## 6. Beslutninger du skal tage

1. **Må en agent rydde op i spike-branches i Baseline?** (a) ja, med backup-tags, (b) du gør det selv. *Anbefaling: (a).*
2. **Server og deploy.** (a) vhost: AddType, DEFLATE og Cache-Control, (b) AllowOverride FileInfo/Headers. Skal CC's deploy.ps1 omdøbes eller slettes? Skal junk-mappen "C:" og gamle .bak-mapper ryddes op? *Anbefaling: (a), omdøb scriptet, og ryd op efter et tjek.*
3. **Coat-testen og CI.** Grænse: "≥ 6 af 8 perturbationer inden for ≤ 1 v / 15 mm" eller p90-baseret? Skal CI pushes, når den er klar? *Anbefaling: 6/8, og push CI efter M2.*
4. **Alpha-PR til MPFB.** (a) post et issue først, eventuelt med link til #400, (b) issue og PR samtidig, (c) behold fixet lokalt. Oplys AI-brug: ja eller nej? *Anbefaling: (a) og ja.*
5. **Morph-model (efter M8).** (i) lineær + 32 corr, (ii) + flere correctives, (iii) MPFB `$md`. *Anbefaling: vent på tallene. Hælder til (iii), hvis pakkestørrelsen stiger under ca. 30 %, ellers (ii).*
6. **breastGate.** (a) behold, så neutrale og mandlige kroppe ikke får bryster, (b) følg MPFB, (c) gør det til et valgfrit lag. *Anbefaling: (c), default on.*
7. **Brystfysik og knogler.** (a) behold `CC_jiggle` på 53 knogler, (b) skift til `game_engine_with_breast` (55), (c) begge som profiler. *Anbefaling: (a) nu og (c) efter native-spiken.*
8. **Original-site.** (a) A+B, (b) kun B. Skal /classic/ fjernes? Lossy WebP på normal maps? *Anbefaling: (b), fjern /classic/, og lossy kun efter Luna-OK.*
9. **Distribution.** (a) git submodule, (b) subtree. Tag-skema? *Anbefaling: (a), som kontrakten siger, med semver 0.x.*
10. **Navnet `CC_`.** (a) privat pladsholder, (b) registrér et vendor-prefix hos Khronos (offentligt). *Anbefaling: (a) indtil videre.*
11. **Pack-metadata.** (a) enkeltords-tags i `.mhclo`, (b) `pack.json`, (c) tags som kilde og `pack.json` som override. *Anbefaling: (c).*
12. **Første native engine.** (a) Godot 4, (b) Unity. Må den installeres under `<tools>`? *Anbefaling: det afgøres af din egen brug. Godot er nemmest headless.*
13. **Cloth-bidrag til MPFB (det vigtigste for dit PR-ønske).**
    - a) Må dine cloth-dele (pin-generering og legShare-idéen, skrevet som ny Python) bidrages under GPL-3.0-or-later?
    - b) Skal det være en kommentar på #228 eller et nyt issue?
    - c) Skal reweight være default eller opt-in? Målt trade-off: cloth-stræk p99 falder fra 1.97 til 1.65, men skin-only-penetration stiger fra 5.5 til 20.1 mm.
    - *Anbefaling: ja, kommentar på #228, opt-in.*
14. **Licens på `dyn_breast_*.target`-filerne:** CC0 (som MakeHuman-assets) eller MIT? *Anbefaling: CC0.* **Afgjort 2026-10-03:** genererede filer, hvis kilder alle er CC0 eller vores egne data, er CC0-1.0 (LICENSE-NOTES.md, "Generated files").
15. **Baseline-repoet:** skal det forblive privat, selv om det er kilden til det offentlige site? *Anbefaling: gør det offentligt, når M0 og M2's sti-scrub er gjort, eller flyt compare-siden ind i CC.*
16. **Rigtig hardware:** vil du køre en Quest 3-test (via adb), før der bygges flere XR-features? *Anbefaling: ja, en kort test efter M9.*
17. **Licens: GPL-3.0-or-later for alle tre repos - besluttet af ejeren 2026-10-03.** Genererede filer med kun CC0-kilder er CC0-1.0; filer afledt af CC-BY-assets beholder kravet om kreditering.

---

## 7. Risici

- **Procesrisiko (VERIFIED, aktiv nu):** Den delte arbejdsmappe giver commits på forkerte branches. M0 er derfor første skridt.
- **Deploy (VERIFIED):** Én kørsel af det gamle script sletter compare-sitet og den eneste backup.
- **Upstream (UNKNOWN):** Maintainerens appetit, svartid og AI-politik er ukendte. Det realistiske udfald kan være "kun pin-gruppe og preset-hjælper", ikke "vores cloth i MPFB". Vi afbøder med alpha-PR'en først og issue før fuld PR.
- **Cloth-kvalitet (VERIFIED):** Stræk p99 1.65-1.97 og ingen periodicitet. Hvis M7b-1 ikke forbedrer det, skal bidraget præsenteres ærligt som authoring- og preview-hjælper.
- **Licens:** siden 2026-10-03 er repoerne GPL-3.0-or-later, så MPFB-afledt kode er ikke længere et licensproblem, men skal krediteres, og den holdes ude af pluginet af arkitekturgrunde (grænsereglen). Lukkede spil kan ikke bruge pluginet uden selv at være GPL-kompatible.
- **Ombasering (VERIFIED omfang):** Den rammer alle GLB'er, sidecars, tests og matricen (30-60 min pr. kørsel). Afbødning: gate før M9/M10, alias-map og baseline-målinger.
- **Native (UNKNOWN):** Understøttelse af quantization og extensions er ukendt. Standardprofilen er 62 % større. M12 kan startes tidligt for at mindske risikoen.
- **Refaktorering af tre hosts på én gang (M9):** Afbødes med paritets-snapshots og grønne suiter før sletning af sync-scripts.
- **Ikke-deterministisk build (UNKNOWN):** Hvis GLB'erne ikke er byte-stabile, kan M11's sha256-accept ikke bruges og må erstattes af en numerisk sammenligning.
- **Visuelle domme:** Alpha-cutoff, WebP-normal maps, breastGate og de kendte visuelle fejl kan kun dømmes af Luna og ejeren. Agenter leverer tal (M2b, M6), men deploy og domme kan blive forsinket.
- **MPFB-tests fra source på Windows** kræver symlink-opsætning. Fejler det, er M7a og M7b blokeret.
- **Estimaterne er INFERRED.** Upstream-kalendertid er ikke med.

---

## 8. Næste 3 konkrete skridt

1. **M0 (ca. 2 timer, kræver dit ja til beslutning 1):**
   - Sæt backup-tags på alle spike-SHA'er.
   - Flyt `ec23ed7` til `spike/export-extension`, og sæt `spike/clothing-standard` tilbage til `4ce8d4e`.
   - Opret én worktree pr. agent under `<scratch>`, og skriv reglen i AGENTS.md.
2. **M1 (lokalt, ca. 1 time):**
   - Få `CharacterCreator\deploy.ps1` til at nægte målet `charactercreator`, og ret CC's AGENTS.md.
   - Verificér med `-DryRun` via PowerShell.
   - Send dig vhost-ændringen som tekst, så du kan lægge den på serveren.
3. **M3 + mpfb2-klon (parallelt, ca. 1 dag):**
   - Bekræft provenance for `macros.js`.
   - Klon mpfb2 (kun fetch) til `<scratch>`, og få MPFB-testsuiten til at køre fra source. Det er forudsætningen for både alpha- og cloth-PR'en.
   - Start tuning-spiken (M7b-1) på stock CC0-assets, så issue-udkastet til #228 kan vise rigtige tal.

---

## Bilag: ændret efter kritisk gennemgang

- Mål 1 og M8b krævede ≤ 0.1 mm på alle 14 kroppe. Det kan ingen model nå (Original ligger på 10.2 mm på mix). Nu: ≤ 0.1 mm på de 11 enkle kroppe og ikke dårligere end Original på de 3 blandede.
- Mål 2 krævede Godot, selv om motoren er din beslutning. Nu: den motor, du vælger.
- Mål 5 påstod, at alle 10 lag er extensions eller `.target`. Shaders og eyeLife er rene runtime-flag.
- Maskinstier fjernet fra planen (mpfb2-klonen og motorinstallationen bruger nu `<scratch>` og `<tools>`). Grep-accepten er formuleret, så den ikke rammer sig selv.
- Antallet af maskinstier rettet fra 9 til 8 trackede linjer (git grep).
- `macros.js` var UNKNOWN. Headeren siger nu (VERIFIED) "skrevet ud fra CC0 `macro.json`". M3 er derfor kortere og handler om at bekræfte påstanden.
- Coat-testen skulle "bestå 10 gange i træk". En deterministisk test giver altid samme resultat, så nu asserter den over de 8 faste perturbationer.
- M6 og M4 havde Luna-review som accept. Nu er accept numerisk (materialetælling, vinkelfejl på normal maps, alpha-dækning), og Luna er en separat gate før deploy.
- M6 lovede ≤ 100 MiB uanset dit valg i beslutning 8. Nu rapporteres størrelsen pr. variant.
- M6 afhang af M1 (deploy). Kun deployet gør det nu. M7a afhang af M6 uden grund.
- M7b-1 brugte vores genererede coat- og dress-skørter til en MPFB-PR. Nu bruges kun stock CC0-assets.
- M7c havde en accept (skørtets pin-tal ±5 %), der krævede GPL-hjælperen i vores MIT-build. Nu: et testasset med en gruppe skrevet af vores egen kode.
- Ny M2b: de kendte visuelle fejl (rødt fragment under kæben, dress+frakke i crouch, trin i dress-skørtet, hår mod krave, bra under dress, manglende `_CCZONE` i anim-GLB) er nu numeriske probes.
- Nyt i M2: determinisme-tjek (forudsætning for sha256-accepten i M11) og en baseline på det *endelige* build, fordi STATUS.md's matrix er fra det næstsidste.
- M8 ligger nu før M10, og M9's sliders ligger bag et interface, fordi en ombasering ændrer morph-indekser.
- M12 kan startes før M10, så standardprofilen bygger på målt loader-support.
- `eye-opened-up` er flyttet ud fra "efter M8b" til M5. Det er standarddata og uafhængigt af ombaseringen.
- AI-oplysning var både en regel og en beslutning. Nu er det kun beslutning 4.
- Licensprincippet er præciseret: dine egne nyskrevne linjer kan være både MIT og GPL, men intet fra en MPFB-fork må gå tilbage. (Afløst 2026-10-03 af beslutning 17: alle tre repos er GPL-3.0-or-later.)
- Nye beslutninger: 15 (Baseline privat eller offentligt) og 16 (test på rigtig hardware).
- Samlet estimat rettet fra 22-30 til 26-36 agentdage, fordi M2b og den større M11 nu er med.
