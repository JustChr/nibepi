"""Take UI screenshots for the NibePi README."""
from playwright.sync_api import sync_playwright
import os

BASE = 'http://nibepi:1880'
OUT  = os.path.join(os.path.dirname(__file__), '..', 'pics')

def take(page, name, prepare=None):
    if prepare:
        prepare()
    page.wait_for_timeout(1200)
    # Crop to actual content height (no empty space below last element)
    content_h = page.evaluate("document.body.scrollHeight")
    vp_h = page.viewport_size['height']
    clip_h = min(content_h, vp_h)
    page.screenshot(path=os.path.join(OUT, name), clip={'x': 0, 'y': 0, 'width': 1280, 'height': clip_h})
    print(f'  saved {name} ({clip_h}px)')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 1920})

    # Load the UI, then switch to English without saving (server config may override localStorage)
    page.goto(BASE)
    page.wait_for_load_state('domcontentloaded')
    page.wait_for_timeout(3500)   # let loadConfig() finish so server lang doesn't override us
    page.evaluate("loadLang('en').then(() => applyLang())")
    page.wait_for_timeout(1500)   # let translations render
    print('UI loaded in English.')

    # ── Registers tab ──────────────────────────────────────────────────────────
    print('Registers tab...')
    page.click('button[data-tab="tab-registers"]')
    page.wait_for_load_state('domcontentloaded')
    page.wait_for_timeout(3000)

    # Open chart for first active register that has a chart button
    chart_btn = page.query_selector('.chart-btn')
    if chart_btn:
        chart_btn.click()
        page.wait_for_timeout(1500)
        # Hover mid-right of chart to show tooltip
        svg = page.query_selector('svg[data-addr]')
        if svg:
            box = svg.bounding_box()
            if box:
                page.mouse.move(box['x'] + box['width'] * 0.62, box['y'] + box['height'] / 2)
                page.wait_for_timeout(400)

    take(page, 'ui_registers.png')

    # ── Status tab ─────────────────────────────────────────────────────────────
    print('Status tab...')
    page.click('button[data-tab="tab-status"]')
    page.wait_for_load_state('domcontentloaded')
    page.wait_for_timeout(3500)

    # Hover over memory chart to show tooltip
    mem_svg = page.query_selector('#mem-chart-svg')
    if mem_svg:
        box = mem_svg.bounding_box()
        if box:
            page.mouse.move(box['x'] + box['width'] * 0.65, box['y'] + box['height'] / 2)
            page.wait_for_timeout(400)

    take(page, 'ui_status.png')

    # ── Settings tab ───────────────────────────────────────────────────────────
    print('Settings tab...')
    page.click('button[data-tab="tab-settings"]')
    page.wait_for_load_state('domcontentloaded')
    page.wait_for_timeout(1500)

    take(page, 'ui_settings.png')

    browser.close()
    print('Done.')
