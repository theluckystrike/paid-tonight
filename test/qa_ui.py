"""Paid Tonight UI QA (draft flow) in a real browser against the dev server. Usage: python3 test/qa_ui.py <base> <outdir>"""
import sys
from playwright.sync_api import sync_playwright
base, out = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp("http://127.0.0.1:9341")
    for w, h, tag in ((1280, 900, "1280"), (390, 844, "390")):
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2)
        page = ctx.new_page(); errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base + "/", wait_until="networkidle")
        page.screenshot(path=f"{out}/01-start-{tag}.png", full_page=True)
        ta = page.locator("textarea").first
        ta.fill("Replaced the kitchen tap for Anna Kowalski, anna@example.com, 2 hours labour at 45 an hour, tap was 89.99, plus 23 percent VAT.")
        page.get_by_role("button", name=lambda n: "invoice" in n.lower()).first.click() if False else page.locator("button", has_text="Make invoice").first.click()
        page.wait_for_function("document.body.innerText.includes('221.39')", timeout=60000)
        page.wait_for_timeout(600)
        page.screenshot(path=f"{out}/02-preview-{tag}.png", full_page=True)
        print(tag, "preview ok; horizontal overflow:", page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), "errors:", errs[:3])
        ctx.close()
