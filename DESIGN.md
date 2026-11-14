---
name: Cashflow Log
description: A family cashflow binder that turns receipts into verified rows in the household's own Google Sheet.
colors:
  graphite-desk: "#0E0D0C"
  warm-graphite: "#171513"
  raised-envelope: "#1D1A17"
  ledger-ink: "#F2EDE4"
  pencil-muted: "#B5AC9F"
  ledger-line: "#332E28"
  amber-tab: "#F0A44B"
  amber-stamp: "#E08A32"
  amber-soft: "#2E2418"
  stamp-ink: "#1B1207"
  income-green: "#9ED8A9"
  income-soft: "#1C2A20"
  ink-red: "#E98C7E"
  paper-desk: "#ECEAE5"
  envelope-paper: "#FAF8F4"
  raised-paper: "#FFFFFF"
  paper-line: "#DDD7CD"
  amber-ink: "#A34E0F"
  income-ink: "#2E6A49"
typography:
  display:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(34px, 3.8vw, 46px)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.045em"
  headline:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 750
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0em"
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.1em"
  data:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "32px"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.045em"
rounded:
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  pill: "999px"
  stamp: "4px"
  tab: "5px"
  nav: "14px"
  feature: "16px"
  rail: "20px"
  card-phone: "22px"
  modal: "28px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "26px"
  xxl: "32px"
components:
  button-commit:
    backgroundColor: "{colors.amber-stamp}"
    textColor: "{colors.stamp-ink}"
    rounded: "{rounded.pill}"
    height: "52px"
    padding: "10px 16px"
  button-primary:
    backgroundColor: "{colors.amber-stamp}"
    textColor: "{colors.stamp-ink}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  envelope-card:
    backgroundColor: "{colors.warm-graphite}"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.xl}"
    padding: "26px"
  input-field:
    backgroundColor: "{colors.warm-graphite}"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  binder-tab:
    backgroundColor: "{colors.amber-stamp}"
    textColor: "{colors.stamp-ink}"
    rounded: "{rounded.sm}"
    width: "68px"
    height: "6px"
  month-strip:
    backgroundColor: "{colors.warm-graphite}"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.xl}"
    padding: "12px 14px"
  history-row:
    backgroundColor: "transparent"
    textColor: "{colors.ledger-ink}"
    rounded: "0"
    padding: "14px 2px"
---

# Design System: Cashflow Log

## Overview

**Creative North Star: "The Family Envelope Binder"**

Cashflow Log looks like the household budget binder that already lives on the kitchen shelf: a graphite desk, matte envelopes, amber index tabs, and stamped states. The surface is precise rather than scrapbooked. Money is the loudest thing on the page, set in tight tabular sans; everything else is a hairline, a label, or a quiet note. The binder metaphor is structural, not decorative: the spread holds a cover, a capture envelope, and the month's page, and the navigation behaves like the tabs that divide them.

The system is dark by default because the primary scene is a family member logging a receipt at the kitchen table after the shops, often in low light; the graphite desk keeps the receipt and the numbers calm. A warm paper theme is available for daylight and for the owner's desktop. Both themes use the same material logic, so a theme change does not change the composition.

The app is an Operate surface: scanning, capture, and correction outrank expression. The amber tab, the stamped reimbursement badge, and the big tabular numerals carry the brand; everything else stays quiet so a receipt can become a verified row without the interface asking for attention.

**Key Characteristics:**
- Graphite desk with matte envelope panels and one warm amber accent.
- Binder tabs, stamped states, and tabular numerals as the recurring signature.
- Hairlines and spacing carry hierarchy; shadows belong only to floating surfaces.
- Phone-first capture with a four-tab binder shell; desktop keeps a sticky rail.
- System sans in a tight, confident scale; no serif revival.

## Colors

The palette is a warm graphite desk with amber index tabs and two functional inks.

### Primary
- **Amber Tab** (#F0A44B): the active binder tab, active rail/nav item, strip link, and primary action. In light theme it darkens to Amber Ink (#A34E0F) for text contrast, while the stamp fill uses Amber Stamp (#D47A1F).
- **Amber Stamp** (#E08A32): filled primary buttons, the capture envelope's binder tab, and the reimbursement stamp. Stamp text is always Stamp Ink (#1B1207).

### Secondary
- **Income Green** (#9ED8A9): income amounts, income badges, and the income stamp. Light theme uses Income Ink (#2E6A49) on Income Soft (#E5F0E8).
- **Ink Red** (#E98C7E): destructive actions and errors. Light theme uses #B3453F.

### Neutral
- **Graphite Desk** (#0E0D0C): page field. Light theme swaps to Paper Desk (#ECEAE5).
- **Warm Graphite** (#171513): envelope and card surface. Light theme uses Envelope Paper (#FAF8F4).
- **Raised Envelope** (#1D1A17): menus, modals, and the mobile nav. Light theme uses Raised Paper (#FFFFFF).
- **Ledger Ink** (#F2EDE4): primary text. Light theme uses #141210.
- **Pencil Muted** (#B5AC9F): secondary text. Light theme uses #5C574F.
- **Ledger Line** (#332E28): hairlines and input strokes. Light theme uses Paper Line (#DDD7CD).

### Named Rules
**The One Tab Rule.** Amber is a state, not a wash. It marks the active tab, the active navigation item, the primary action, and the reimbursement stamp; it never becomes the page background or a decorative gradient.

**The Stamp Contrast Rule.** Every amber fill carries Stamp Ink (#1B1207), never white. Every green fill carries the dark income ink; every red fill carries white only where the fill is dark enough.

## Typography

**Display Font:** system sans (`ui-sans-serif`, `-apple-system`, `Segoe UI`, Roboto, Helvetica Neue, Arial)
**Body Font:** the same system sans
**Data Font:** the same system sans with tabular numerals

**Character:** A tight, plainspoken grotesque. The display sizes are heavy and closely tracked; body copy stays open and readable; labels are small, uppercase, and spaced. The system stack is deliberate: this is a working household tool, not an editorial publication, and the page should load instantly on a phone with no font request.

### Hierarchy
- **Display** (800, clamp 34–46px, 0.98, −0.045em): the cover statement on desktop and the entry heading.
- **Headline** (800, 22px, 1.15, −0.035em): card titles, month title, modal titles, empty-state titles.
- **Title** (750, 15px, 1.25, −0.015em): merchant names, row titles, menu labels.
- **Body** (400, 15px, 1.6, 0): explanatory copy, form text, settings descriptions; measure stays near 40ch in the cover column.
- **Label** (700, 10–12px, 1.2, 0.08–0.12em, uppercase): field labels, stamps, month tabs, section labels.
- **Data** (800, 32px, 1.05, −0.045em, tabular): month spend and stat values. The strip hero runs 24px on phones and 18–20px in the desktop month index.

### Named Rules
**The Tabular Money Rule.** Every amount, count, and date column uses `font-variant-numeric: tabular-nums` and tight tracking; money never wobbles between rows.

**The No Serif Rule.** There is no serif in the system. The binder's authority comes from weight, spacing, and the amber tab, not from an editorial face.

## Layout

The desktop is a two-part spread: a 168px sticky binder rail on the left and a fluid binder panel on the right, capped at 1280px. Inside the panel, the entry spread is a cover column plus a 1.15fr capture envelope; a compact month strip occupies the top of the envelope column, directly above the capture envelope. At 921–1220px the strip wraps to two rows so the spent amount and reimbursement stamp never clip; at 1221px and above it is a single row. Overview and History sit below as full-width binder pages. The mobile shell is a single column: a compact month strip, the capture envelope, and a fixed four-tab bottom nav. At ≤360px the month strip yields entirely so the camera and gallery stay above the sticky commit dock; the month remains available in Overview.

Spacing follows a tight rhythm: 6–8px inside a control, 12–14px between related fields, 18–26px between groups, and 32px between the cover and the envelope. Desktop cards use 16–20px of padding in the compact laptop range and 26px for the binder pages below. The phone uses 20px card padding and a 68px bottom-nav reserve plus the safe-area inset.

Breakpoints: 360px (strip yields), 480px (phone typography), 920px (rail becomes bottom nav), 921px (rail returns), 1220px (desktop strip returns to one row), 1366px (laptop compacting ends).

## Elevation & Depth

The system is flat by default. Cards sit directly on the desk with a hairline border; the entry card's amber tab is the only raised gesture. Depth appears only on surfaces that actually float: the binder rail, the month strip, menus, and modals use a soft, offset shadow. There is no backdrop blur, no glass, and no decorative gradient. Tonal contrast between the desk, the envelope, and the field carries the rest.

### Shadow Vocabulary
- **Floating surface** (`0 12px 28px -18px rgba(0, 0, 0, 0.65)`): the rail and month strip at rest.
- **Modal lift** (`0 22px 50px -30px rgba(0, 0, 0, 0.85)`): menus, dialogs, and the PIN gate card.

### Named Rules
**The Flat-Envelope Rule.** If a surface is part of the page, it is flat and hairline-bordered. Shadow is reserved for something that can be dismissed, dragged, or floats above the spread.

## Shapes

Envelopes and binder pages use 24px corners; phone cards use 22px; modals use 28px; rails use 20px and the bottom nav 14px. Inner fields use 12px; chips, stamps, and small tabs use 4–8px; primary actions and filters are full pills. The recurring silhouette is the amber tab: a 68×6px rounded bar clipped to the top edge of the capture envelope. Stamps are small rectangles with a 4px corner, never pills. History rows are ruled ledger lines with a 1px bottom hairline, not nested cards. Hairlines are 1px; dashed rules mark the boundaries of a form section or an empty pocket.

## Components

### Buttons
- **Shape:** pills (999px), 44px minimum on touch, 52px for the commit action.
- **Primary:** the commit button uses Amber Stamp with Stamp Ink at rest and deepens to Amber Hover on hover; feature dialogs use the same amber treatment.
- **Hover / Focus:** hover deepens the amber or lifts the surface to the field color; focus is a 2px amber outline with a 2px offset.
- **Secondary / Ghost:** transparent with a 1px Ledger Line border; hover fills with the field color.

### Chips
- **Style:** full pills with Ledger Line borders and a field background; 12px text, 7px × 12px padding.
- **State:** selected chips use amber text on Amber Soft, or the ink/desk inversion for strong selection in dark theme. The filter count is a small amber badge.

### Cards / Containers
- **Corner Style:** 24px for envelopes and binder pages; 16px for nested feature rows.
- **Background:** Warm Graphite / Envelope Paper; the desk is one step darker.
- **Shadow Strategy:** flat at rest; floating surfaces only.
- **Border:** 1px Ledger Line; dashed for empty pockets and form boundaries.
- **Internal Padding:** 26px desktop, 20px phone; 14px vertical for ruled history rows.

### Inputs / Fields
- **Style:** 12px radius, 1px Ledger Line, field background, 15px text (PIN fields use 20px mono with tracked digits).
- **Focus:** amber border plus a 3px Amber Soft halo; focus-visible gets a 2px amber outline.
- **Error / Disabled:** errors use Ink Red on the error surface; disabled commit buttons use the field-hover fill with faint text.

### Navigation
- **Desktop rail:** sticky 168px panel, 44px rows, 12px radius; the active row uses Amber Soft with amber text. The rail label is 10px uppercase.
- **Mobile nav:** fixed four-tab bar with 20px drawn line icons, 11px labels, and a 48px target; the active tab uses Amber Soft with amber text. The nav sits above the safe-area inset; the commit dock sits directly above it.
- **Sections:** Entry, Overview, History, Settings. Settings is a full panel on mobile and the existing menu on desktop.

### Signature Components
- **Capture Envelope:** a 24px card with a 68×6px amber tab clipped to the top edge, a pill tab switcher, a dashed photo pocket, and a commit dock. The photo pocket always keeps Camera and Gallery visible above the dock on phones.
- **Month Strip:** the compact first-screen summary: month tab, spent hero in tabular numerals, net at right, a reimbursement stamp, and an entry count. On phones it is a 124px card above the capture envelope; on desktop it becomes a 40px horizontal index above the envelope (two rows at 921–1220px), with the entry count in the dashboard sub. It yields at ≤360px.
- **Stamped State:** a 4px-radius rectangle with 10px uppercase text; amber for reimbursement, green for income, red for danger.

## Do's and Don'ts

### Do:
- **Do** keep the amber tab as the only raised gesture on the capture envelope, at 68×6px.
- **Do** use tabular numerals for every amount, count, and date.
- **Do** clamp long merchant names to two lines and let the amount hold the right edge.
- **Do** keep Camera and Gallery above the sticky commit dock at 390px and 320px.
- **Do** use hairlines, dashed rules, and spacing before reaching for a shadow.
- **Do** flatten history entries into ruled ledger rows with a 1px bottom hairline.
- **Do** theme the browser surface: focus rings, selection, caret, scrollbars, and file inputs come from the same palette.

### Don't:
- **Don't** use gradients, glass, or backdrop blur; the world is matte.
- **Don't** turn every section into a same-size icon/heading/text card, or nest cards inside the history page; the spread is the structure.
- **Don't** use amber for body copy or large background fields; it is a state and an action color.
- **Don't** use a serif or a decorative display face; the system sans is the voice.
- **Don't** hide the month entirely on phones without leaving it available in Overview.
