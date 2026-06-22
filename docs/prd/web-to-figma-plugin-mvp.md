# Web to Figma Plugin MVP PRD

## Problem Statement

Designers and developers who see a rendered webpage in Chrome have to recreate it manually in Figma before they can refine, reuse, or discuss it. Screenshot-only tools preserve pixels but destroy editability; fragile importers create unreadable layers or distort the page by forcing an unsuitable layout model.

The first product milestone is therefore not a commercial funnel. It is a reliable Chrome-to-Figma plugin experience that converts one rendered webpage into useful, editable Figma layers with as little interruption as possible.

## Solution

Deliver a desktop Chrome extension and Figma plugin working together to perform a **single-page conversion**. A user captures either a complete scrollable page or one selected component; the Figma plugin creates a named root result containing editable text, image, vector, and container layers.

The plugin prioritizes usable output: conventional web content remains editable, while complex content is visually preserved through local degradation. Before import, the user chooses either visual fidelity or editable layout. The processing UI is a dark, focused progress view with a clear cancel action. A successful import lands directly on the result without reports, metrics, or warning panels.

## User Stories

1. As a Figma user, I want to install one Chrome extension and one Figma plugin, so that I can move from a live webpage to an editable Figma result.
2. As a Chrome user, I want to capture the webpage I am currently viewing, so that the result reflects the actual rendered state rather than raw source HTML.
3. As a user, I want to capture a full scrollable page, so that I can redesign an entire webpage without rebuilding it manually.
4. As a user, I want to select one visible component on a page, so that I can bring only the section I need into Figma.
5. As a user, I want the selection affordance to make the capture target obvious before I start, so that I do not import the wrong region.
6. As a user, I want the current rendered viewport width to be retained, so that a page captured at a chosen responsive state looks the same in Figma.
7. As a Figma user, I want to paste a URL in the plugin as an alternate starting point, so that Chrome can open and capture that page without my manually navigating first.
8. As a user, I want Chrome to perform URL-based capture, so that logged-in, dynamic, and browser-rendered pages retain their actual state.
9. As a user, I want normal webpage text to become editable Figma text, so that I can change copy after import.
10. As a user, I want headings, paragraphs, labels, and button text to remain separate, so that the layer structure is usable.
11. As a user, I want common containers, buttons, inputs, and navigation to retain sensible parent-child structure, so that I can edit a page without untangling meaningless wrappers.
12. As a user, I want webpage images to become replaceable Figma image nodes, so that I can reuse the layout with different content.
13. As a user, I want CSS backgrounds, border radii, shadows, gradients, clipping, and common image fitting behavior to survive import, so that the result resembles the rendered webpage.
14. As a user, I want ordinary SVG content to remain editable when possible, so that icons and simple graphics do not become unnecessary screenshots.
15. As a user, I want complex unsupported visual content to preserve its appearance locally, so that a difficult chart, canvas, video frame, or SVG does not break the page.
16. As a user, I never want the whole webpage silently flattened into one image, so that the product remains useful for continued design work.
17. As a user, I want to choose visual fidelity before import, so that uncertain layout inference does not move elements away from their rendered position.
18. As a user, I want to choose editable layout before import, so that safe flex, grid, and flow structures can become Figma Auto Layout where that helps future editing.
19. As a user, I want missing web fonts to fall back automatically, so that a page still imports instead of stopping on an unavailable font.
20. As a user, I want to choose one replacement font before import when needed, so that I can make imported text consistent without a manual cleanup pass.
21. As a user, I want readable, deterministic layer names, so that I can find imported content without relying on AI-generated names.
22. As a user, I want to see a focused conversion progress interface, so that I know the task is running without being shown irrelevant diagnostics.
23. As a user, I want the active processing stage and overall progress to update while conversion runs, so that a long import does not feel frozen.
24. As a user, I want to cancel an in-progress conversion, so that I can stop an unwanted or slow task.
25. As a user, I want cancellation to remove all partial layers from that import, so that my Figma canvas remains clean.
26. As a user, I want successful imports to select or focus the generated result, so that I can begin editing immediately.
27. As a user, I want a brief retry action only when the full import cannot complete, so that I can recover without reading a technical report.
28. As a user, I do not want node counts, warning lists, font reports, or routine technical messages after success, so that the workflow stays lightweight.
29. As a user, I want a single webpage per task, so that the first version is predictable and reliable.
30. As a user, I want the plugin to process pages regardless of their website category, so that the product does not force a public-page or page-type whitelist.

## Implementation Decisions

- The existing baseline is a Manifest V3 Chrome capture extension. It already supports complete-page preparation, component selection, lazy-asset preparation, HD asset selection, and a JSON download result. It does not contain a Figma plugin or Figma node importer. The MVP extends this baseline into a paired Chrome extension and Figma plugin rather than replacing working capture behavior.
- Figma is the only design target and desktop Chrome is the only formally supported capture browser.
- The plugin supports only two capture methods: complete page capture and selected-component capture. Current-viewport capture, multi-URL batches, multi-tab batches, and interaction-flow recording are excluded.
- Every task is a single-page conversion at the page's current rendered responsive state. The product does not generate multiple breakpoints in one task.
- A URL entered in Figma is a Chrome-capture command, not a request for the Figma plugin or a cloud renderer to crawl a site directly.
- The conversion pipeline captures final DOM geometry and computed styles, then creates platform-neutral scene data before Figma node generation. This keeps capture and Figma APIs decoupled while the first shipping target remains Figma.
- The node generator creates real Figma Text, Frame, image-fill, and Vector nodes where fidelity is reliable. It preserves meaningful hierarchy and flattens non-visual wrappers rather than mirroring every DOM node.
- The conversion uses mixed output. Conventional content stays editable; complex or unsupported local regions can be rasterized. Whole-page rasterization is prohibited.
- The user selects an import layout preference: **visual fidelity** favors fixed coordinates; **editable layout** attempts safe Auto Layout conversion. Explicit flex, simple grid, regular flow, and absolute-position behavior are interpreted according to this preference without sacrificing visible placement.
- Font handling is non-blocking. The importer selects the closest available Figma font or a user-specified substitute and continues without a user-facing font report.
- Layer names come from deterministic webpage semantics such as ARIA labels, roles, meaningful identifiers, and text summaries. Generative AI naming is not part of the first release.
- Image assets are deduplicated per task. The functional MVP must create replaceable image nodes; entitlement-based image-resolution differences are deferred with payments and subscriptions.
- The user-facing processing UI follows the supplied dark progress-panel reference: central page illustration, source URL, vertical staged progress, current-stage progress, and cancel. Account, credit, upgrade, duplicate bilingual metadata, and technical diagnostics are not part of this MVP UI.
- The existing proxy, concurrency, diagnostics, and asset-quality controls are engineering mechanisms, not the normal user journey. The MVP UI hides them behind non-primary development or recovery surfaces until a user need justifies exposing them.
- Success navigates directly to the created result. No conversion report, statistics panel, routine warning list, or completion dashboard is shown.
- A complete-task failure shows one short, actionable message with retry. Local visual degradation that successfully preserves the result does not interrupt the user.
- Cancellation is transactional from the user's perspective: halt work, remove every node created by the task, and return to the starting state.
- Payment collection, subscriptions, quota enforcement, marketing website, teams, enterprise controls, and private deployment are not implementation prerequisites for this PRD.

## Testing Decisions

- The highest-value seam is the observable conversion journey: rendered Chrome fixture page → captured scene data → Figma import → editable Figma result. Tests should assert externally visible output, not internal DOM-parser or node-creator implementation details.
- Build a stable fixture library containing a marketing page, dashboard-like layout, form, responsive layout, nested flex layout, simple grid, SVG, background images, gradients, font fallback, fixed elements, and unsupported visual content.
- At the Chrome-extension seam, test complete-page and component capture against fixture pages, including lazy assets and the actual chosen responsive width.
- At the scene-data seam, test that capture output preserves hierarchy, text runs, geometry, layout intent, asset deduplication, and local degradation markers without coupling tests to Figma API objects.
- At the Figma-plugin seam, test that imports create editable text, replaceable image nodes, meaningful parents, deterministic names, chosen layout behavior, and no whole-page screenshot fallback.
- Add visual regression checks that compare each fixture's source rendering with its imported Figma rendering at the same viewport, focusing on major positioning, typography, color, clipping, and image behavior.
- Add end-to-end tests for the two capture methods, the Figma-URL-to-Chrome handoff, progress updates, successful focus on the result, retry after full failure, and cancellation cleanup.
- Test user-facing behavior for silent font substitution and local degradation: the import completes without a report, while complete failure exposes only a concise retry path.
- Test large-page responsiveness by exercising batched Figma node creation and cancellation during active creation; the Figma UI must not remain frozen and no partial nodes may remain after cancellation.
- Existing prior art is the Node-based `runner` test suite, which covers full-page preparation, bounded lazy-loading scroll, HD asset promotion, progress events, component selector forwarding, and temporary hiding of extension UI. Preserve and extend this seam; add fixture and end-to-end seams before feature expansion.

## Out of Scope

- Payment processing, subscription checkout, pricing enforcement, weekly Free quotas, Pro entitlement verification, account-management UI, and refund flows.
- Marketing website, landing page, analytics dashboard, team seats, enterprise plans, private deployment, offline mode, and support operations.
- Browsers other than desktop Chrome.
- Design targets other than Figma.
- Multiple-page or multiple-tab batch conversion.
- Click, hover, login-route, state-machine, or interaction-flow recording.
- Automatic generation of desktop, tablet, and mobile breakpoints in one task.
- Generative-AI layer naming or other AI enhancement features.
- Source-code export, framework-code import, and business-logic reconstruction.
- Whole-page rasterization as an import shortcut.

## Further Notes

- The shared language in `CONTEXT.md` is authoritative for future work. `docs/product/open-decisions.md` records deliberately deferred product decisions and must not be mistaken for current MVP scope.
- Existing commercial decisions remain useful future context, but the implementation order is explicit: make the core plugin reliable and pleasant before reconnecting payment, web, or broader platform work.
- The plugin must avoid page-type or ownership whitelists in its product behavior. Browser and Figma platform limitations may require visible-content degradation, but must not cause unrelated elements to stop a task.
- The current extension's JSON-download behavior is a technical bridge only. The intended MVP completion path is import into Figma, not asking the user to manage an exported JSON file.
