import { expect, test } from "@playwright/test";
test.beforeEach(async ({ page }) => {
 // No backend or credentials: dashboard errors exercise its real filter layout.
 await page.route("**/v1/**", route => route.fulfill({status:503, contentType:"application/json", body:"{}"}));
 await page.goto("/browser/dropdowns.html");
});
test("keyboard, focus, typeahead, empty choice, disabled items and required validation", async ({ page }) => {
 const trigger = page.getByRole("combobox", {name:"Required choice"});
 await page.getByRole("button", {name:"Submit fixture"}).click();
 await expect(page.getByLabel("Submitted")).toHaveText("false");
 await expect(trigger).toBeFocused();
 await trigger.press("ArrowDown");
 await expect(page.getByRole("option",{name:"Choose…"})).toBeFocused();
 await page.keyboard.press("Home");
 await page.keyboard.press("ArrowDown");
 await page.keyboard.press("ArrowDown");
 await page.keyboard.press("Enter");
 await expect(page.getByLabel("Choice", {exact:true})).toHaveText("beta");
 await expect(trigger).toBeFocused();
 await trigger.press("Space");
 await expect(page.getByRole("option",{name:"Beta",exact:true})).toBeFocused();
 await page.keyboard.type("alp",{delay:0});
 await page.keyboard.press("Enter");
 await expect(page.getByLabel("Choice", {exact:true})).toHaveText("alpha");
 await trigger.press("Enter");
 await expect(page.getByRole("option",{name:"Alpha",exact:true})).toBeFocused();
 await page.keyboard.press("End");
 await page.keyboard.press("Escape");
 await expect(trigger).toBeFocused();
 await expect(page.getByLabel("Choice", {exact:true})).toHaveText("alpha");
 await trigger.press("Enter");
 await expect(page.getByRole("option",{name:"Alpha",exact:true})).toBeFocused();
 await page.keyboard.press("ArrowDown");
 await page.keyboard.press("Tab");
 await expect(page.getByRole("listbox")).toHaveCount(0);
 await expect(page.getByLabel("Choice",{exact:true})).toHaveText("alpha");
 await expect(page.getByRole("button", {name:"Submit fixture"})).toBeFocused();
 await page.getByRole("button", {name:"Submit fixture"}).click();
 await expect(page.getByLabel("Submitted")).toHaveText("true");
 await trigger.click();
 await page.getByRole("option", {name:"Choose…"}).click();
 await expect(page.getByLabel("Choice", {exact:true})).toHaveText("");
 await expect(page.getByRole("combobox", {name:"Disabled",exact:true})).toBeDisabled();
 await expect(page.getByRole("combobox", {name:"Disabled by fieldset"})).toBeDisabled();
});
for (const width of [320, 550, 1280]) for (const colorScheme of ["light", "dark"] as const) {
 test(`dashboard and popup fit ${width}px ${colorScheme}`, async ({page}) => {
  await page.setViewportSize({width,height:720}); await page.emulateMedia({colorScheme});
  const period=page.getByRole("combobox", {name:/Period/});
  await period.click(); await page.getByRole("option", {name:"Last 7 days"}).click();
  await expect(period).toContainText("Last 7 days");
  await page.getByRole("tab", {name:"Usage"}).click();
  await expect(period).toContainText("Last 7 days");
  const trigger=page.getByRole("combobox",{name:"Required choice"});
  await trigger.click();
  const popup=page.getByRole("listbox");
  await expect(popup).toBeVisible();
  const bounds=await popup.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
  expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(720);
  await page.screenshot({path:`test-results/dropdown-${width}-${colorScheme}.png`});
  await page.keyboard.press("Escape");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 });
}
