# Mål

Ejerens mål for projektet, skrevet ned efter samtalerne den 2.-3. oktober 2026. Det er
mål, ikke en plan: planen står i `ROADMAP.md`. Hvert mål har en kort begrundelse og et
testbart tegn på, at det er nået. Status er ærlig: "nået", "delvist" eller "ikke startet".

Mærkater: **BESLUTTET** (ejeren har sagt det), **FORSLAG** (aftalt retning, detaljer åbne).

## 1. Karaktersystemet er pluginet (BESLUTTET)

- `character-system/` er produktet. WebXR-appen og compare-siden er kun demo-værter.
- Værter er både web og native motorer (Unity, Godot, Unreal). Én motor ad gangen bevises.
- Alle skal kunne lave tøjpakker. Distribution sker som en mappe i git (submodule eller subtree).
- Tegn på nået: en fremmed kan lave en tøjpakke uden at ændre kode, og en anden vært end
  vores egen viser den samme figur. Status: ikke nået (se ROADMAP M9-M12).

## 2. Byg så direkte på originalen som muligt (BESLUTTET)

- Brug MakeHuman/MPFB's data, værktøjer og konventioner (makro-targets, game_engine-rig,
  `.mhclo`-tøj med MPFB's tilpasning, materialer, standard glTF) i stedet for private varianter.
- Det vi selv har lagt ovenpå (cloth, brystfysik, tøjregler, øjenliv, shaders) er navngivne,
  valgfrie lag, som kan slås fra.
- Tegn på nået: med alle vores lag slået fra giver buildet en krop, der ligger inden for
  måletolerancerne af MPFB, og hvert lag kan slås til enkeltvis. Status: delvist (kroppen,
  riggen og klippene er allerede MPFB-data; morph-modellen er ikke afgjort).

## 3. Sammenligningen afgør, hvad vi beholder (BESLUTTET)

- Siden på `https://dionysus.dk/webxr/charactercreator/` viser Vores og Original med samme
  animationer, tøj og indstillinger, så ejeren selv kan vurdere, om vores ændringer er værd at beholde.
- Hvert lag får en dom (behold, drop, valgfri, ubeslutt) med et målt tal bag.
- Tegn på nået: `docs/DECISIONS.json` har én dom pr. lag med kilde. Status: delvist (siden er
  live, tavlen er under arbejde i fase 1/M4).

## 4. Tøj er almindelige MakeHuman-assets, cloth er et valgfrit tillæg (FORSLAG)

- Et stykke tøj skal kunne bruges som et normalt MakeHuman-asset (`.mhclo`, `.obj`, `.mhmat`)
  og stadig virke i MakeHuman og MPFB, bare uden fysik.
- Fysikdata er ekstra data, som standardværktøjer ignorerer: en sidefil
  (`<navn>.cloth.json`), et tag eller en vertex-gruppe (`mhmask-cloth-pin`). Hvilke bærere der
  overlever MPFB og vores pipeline, er under test (`spike/cloth-ext`).
- Uden fysikdata får tøjet standardværdier ud fra sin type, så fremmede tøjpakker virker.
- Tegn på nået: et uændret CC0-`.mhclo`-pack kan bygges og simuleres hos os uden kodeændringer,
  og samme pack åbner i MPFB uden fejl. Status: ikke startet (afventer test af bærere).

## 5. Vores cloth-arbejde bidrages til MPFB, hvis det kan lade sig gøre (FORSLAG)

- Mest realistisk som en Blender-hjælper til at sætte cloth op på MPFB-tøj (pin-grupper,
  kollisionskrop, bagt resultat), ikke som en port af vores JavaScript-solver.
- Første PR er den lille alfa-rettelse til `.mhmat` (tillidsopbygning), derefter cloth-hjælperen.
- Intet postes offentligt uden ejerens ja pr. handling. Agenter laver kun kladder og lokale grene.
- Tegn på nået: kladder, tests og udkast til issue/PR ligger klar, så ejeren kan sige ja eller nej.
  Status: delvist (M7a og M7b er i gang eller planlagt).

## 6. Licens (BESLUTTET 3. oktober 2026)

- Kode: GPL-3.0-or-later i alle tre repos. Det passer til MPFB og til ejerens måde at arbejde på.
- Genererede filer (figurer, tøj-GLB, targets, klip, kataloger) er CC0, hvor alle kilder er CC0.
  Dele afledt af CC-BY-assets er ikke CC0, og attribution følger med.
- MPFB bruges som byggeværktøj. Data går over grænsen mellem værktøj og runtime, ikke kode.
  Det er nu en arkitekturregel (holder pluginet uafhængigt af Blender), ikke et licenskrav.
- Dette er ikke juridisk rådgivning.
- Tegn på nået: `LICENSE` er standard GPL v3, noterne er opdaterede, og GitHub genkender licensen.
  Status: i gang (grenen `license/gpl`, ikke pushet endnu).

## 7. Arbejdsregler (BESLUTTET)

- Agenter må rette kode, men arbejder i egne grene og worktrees. Intet til master uden
  gennemgang, intet `git add -A`.
- Opus-agenter ser ikke på billeder. Billeder vurderes af Luna (GPT 6 Luna via Codex) og ejeren.
  En agents acceptkriterier er altid numeriske.
- Intet offentligt uden ejerens ja pr. handling: push, fork, issue, PR, kommentar og deploy.
- Hvert resultat rapporteres ærligt med PASS, FAIL, PARTIAL eller BLOCKED-ON-OWNER og beviset.

## Åbne spørgsmål til ejeren

Se `ROADMAP.md` afsnit 6 for de nummererede beslutninger (blandt andet morph-model, breastGate,
server-konfiguration, første native motor, om Baseline-repoet skal være offentligt).
