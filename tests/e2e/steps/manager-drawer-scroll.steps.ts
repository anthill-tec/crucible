// CR-CRU-174 §S3 (issue 6) — manager-drawer-no-horizontal-scroll.feature
// steps. Reuses seeding.steps.ts's registration idiom (`seedProject`, now
// accepting an optional sutRoot — see tests/e2e/steps/harness.ts),
// navigation.steps.ts's "I open the home page", manager.steps.ts's "I click
// the manage chip" / "the projects manager is visible", and pane-scroll.
// steps.ts's "the viewport is {int}x{int}". Only the long-sutRoot
// registration and the drawer scroll-geometry assertion are new here.
//
// MEASURED (not assumed): [data-testid="projects-manager"]'s content
// wrapper (ProjectsManager in public/app.js) reuses the generic
// .app-pane-content class — which pulls in the UNRELATED CR-CRU-023
// .app-pane-content > * { min-width: 660px } floor (public/styles.css)
// meant for the workspace's own central panes, not the manager. That is
// the exact defect the CR's issue 6 measured ("its content box
// (.app-pane-content) is 660 px wide inside a 531 px pane"). The outer
// .app-manager box itself (a flex-direction:column scroll container) does
// NOT reliably surface this in its OWN scrollWidth — confirmed via
// getBoundingClientRect(): the overflowing row's right edge sits well past
// the drawer's own, yet .app-manager.scrollWidth never grows past its
// clientWidth. So "the drawer's content scrollWidth <= clientWidth" is
// asserted per ELEMENT, sweeping every node inside the drawer — this is
// also the more faithful reading of the AC, since F12's fix is that EVERY
// fact fits its OWN line/box, not merely that the outer shell happens to
// clip whatever doesn't.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { seedProject } from "./harness.ts";

// An UNBROKEN (no space, hyphen or slash within the run — all are CSS break
// opportunities under normal text layout; measured, a plain multi-segment
// `/a/b/c/...` path wraps fine at each slash and never reproduces the
// defect) long token, same technique mobile-viewport.steps.ts's
// "unbreakable long agent id" step uses to force genuine content-driven
// overflow rather than a value normal word-wrap would already have handled.
const LONG_SUT_ROOT = `/home/dev/${"overflowsegment".repeat(20)}/crucible-project-root`;

Step(
  "a project named {string} is registered with a long sutRoot",
  async ({ request, world }, name: string) => {
    world.projectKey = await seedProject(request, name, undefined, LONG_SUT_ROOT);
  },
);

interface Offender {
  selector: string;
  scrollWidth: number;
  clientWidth: number;
}

Step("the manager drawer does not scroll horizontally", async ({ page }) => {
  const drawer = page.getByTestId("projects-manager");
  await expect(drawer).toBeVisible();
  const offenders = await drawer.evaluate((root) => {
    // Sub-pixel rounding slack only — not a loophole for real overflow.
    const TOLERANCE = 1;
    const found: Offender[] = [];
    const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
    for (const node of nodes) {
      if (node.scrollWidth > node.clientWidth + TOLERANCE) {
        found.push({
          selector:
            node.getAttribute("data-testid") ??
            (node.className ? `.${String(node.className).split(" ").join(".")}` : node.tagName),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        });
      }
    }
    return found;
  });
  expect(
    offenders,
    `the projects-manager drawer contains element(s) whose content overflows its own box ` +
      `(scrollWidth > clientWidth), which is what makes the drawer scroll sideways: ` +
      JSON.stringify(offenders),
  ).toEqual([]);
});
