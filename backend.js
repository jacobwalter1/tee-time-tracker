const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { chromium } = require('playwright');

dotenv.config();

function toDateInputValue(date, format = 'label') {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new TypeError('date must be a valid Date object');
    }

    if (format === 'number') {
        return date.getDate();
    }

    if (format === 'iso') {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
    });
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getCourseContext(page, course) {
    if (!course.frameUrlIncludes) return page;

    const existingFrame = page.frames().find(item => item.url().includes(course.frameUrlIncludes));
    if (existingFrame) return existingFrame;

    try {
        return await page.waitForEvent('framenavigated', {
            predicate: frame => frame.url().includes(course.frameUrlIncludes),
            timeout: 15000
        });
    } catch {
        throw new Error(`${course.name}: booking iframe did not finish loading`);
    }
}

const currencyPattern = /(?:US\$|USD\s*|\$)\s*\d+(?:,\d{3})*(?:\.\d{1,2})?/i;

function normalizePrice(value) {
    return value?.replace(/^US\$|^USD\s*/i, '$').replace(/\s+/g, '') || null;
}

function readHolePrices(value) {
    const text = String(value).replace(/\s+/g, ' ').trim();
    const priceMatches = [...text.matchAll(new RegExp(currencyPattern.source, 'gi'))];
    const cartPriceIndexes = new Set();

    for (const cartMatch of text.matchAll(/\bcart(?:\s+fee)?\b/gi)) {
        const priceAfterCart = priceMatches.find(match =>
            match.index > cartMatch.index && match.index - cartMatch.index <= 50
        );
        const priceBeforeCart = [...priceMatches].reverse().find(match =>
            match.index < cartMatch.index && cartMatch.index - match.index <= 50
        );
        const cartPrice = priceAfterCart || priceBeforeCart;
        if (cartPrice) cartPriceIndexes.add(cartPrice.index);
    }

    const nonCartPrices = [...new Set(
        priceMatches
            .filter(match => !cartPriceIndexes.has(match.index))
            .map(match => normalizePrice(match[0]))
    )];

    function labeledPrice(holes) {
        const currency = currencyPattern.source;
        const afterLabel = new RegExp(`\\b${holes}\\s*holes?\\b.{0,50}?(${currency})`, 'i');
        const beforeLabel = new RegExp(`(${currency}).{0,50}?\\b${holes}\\s*holes?\\b`, 'i');
        const match = text.match(afterLabel) || text.match(beforeLabel);
        if (/cart/i.test(match?.[0] || '')) return null;
        return normalizePrice(match?.[1]);
    }

    let nineHoles = labeledPrice(9);
    let eighteenHoles = labeledPrice(18);

    // Some providers distinguish the two green fees visually instead of including
    // hole labels in the accessible text. Preserve their displayed order after
    // removing any amount explicitly associated with a cart fee.
    if (!nineHoles && !eighteenHoles && nonCartPrices.length >= 2) {
        [nineHoles, eighteenHoles] = nonCartPrices;
    }

    const labeledPrices = [nineHoles, eighteenHoles].filter(Boolean);
    return {
        nineHoles,
        eighteenHoles,
        listed: labeledPrices.length === 1 ? labeledPrices[0] : nonCartPrices[0] || null
    };
}

async function scrapeCourseInBrowser(browser, course, selectedDate) {
    const startedAt = Date.now();
    const results = [];
    const errors = [];
    const courseUrl = course.urlFromEnv ? process.env[course.urlFromEnv] : course.url;
    if (!courseUrl) throw new Error(`${course.name}: missing course URL`);

    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

    try {
        await page.goto(courseUrl, { waitUntil: 'networkidle', timeout: 30000 });
        const context = await getCourseContext(page, course);

        for (const step of course.steps) {
            if (step.action === 'fill') {
                const value = step.valueFromEnv ? process.env[step.valueFromEnv] : step.value;
                if (!value) throw new Error(`${course.name} / ${step.name}: missing value`);
                await context.locator(step.selector).first().fill(value);
            } else if (step.action === 'click') {
                if (step.role && step.accessibleName) {
                    await context.getByRole(step.role, { name: step.accessibleName }).first().click();
                } else {
                    await context.locator(step.selector).first().click();
                }
            } else if (step.action === 'selectDate') {
                if (step.skipIfToday && toDateInputValue(selectedDate, 'iso') === toDateInputValue(new Date(), 'iso')) {
                    continue;
                }
                const dateFormat = step.dateFormat || 'label';
                const dateValue = toDateInputValue(selectedDate, dateFormat);
                if (step.role) {
                    await context.locator(step.selector).first().getByRole(step.role, {
                        name: String(dateValue),
                        exact: step.exact === true
                    }).click();
                } else {
                    const exactDate = new RegExp(`^\\s*${escapeRegExp(dateValue)}\\s*$`);
                    const dateOption = context.locator(step.selector).filter({ hasText: exactDate }).first();
                    await dateOption.click();
                }
            } else if (step.action === 'selectCityDate') {
                // DriverPOS now asks for the date in a booking options form.
                await context.getByRole('button', { name: /^\d{4}-\d{2}-\d{2}$/ }).click();
                const targetMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
                for (let attempt = 0; attempt < 13; attempt++) {
                    const caption = await context.locator('table.rdp-month_grid').first().getAttribute('aria-label');
                    const shownMonth = new Date(`${caption} 1`);
                    if (Number.isNaN(shownMonth.getTime())) throw new Error(`${course.name}: unrecognized calendar month ${caption}`);
                    const difference = (targetMonth.getFullYear() - shownMonth.getFullYear()) * 12 + targetMonth.getMonth() - shownMonth.getMonth();
                    if (difference === 0) break;
                    if (attempt === 12) throw new Error(`${course.name}: requested date is outside the calendar range`);
                    await context.getByRole('button', { name: difference > 0 ? 'Go to the Next Month' : 'Go to the Previous Month' }).click();
                }
                await context.locator(`td[data-day="${toDateInputValue(selectedDate, 'iso')}"] button`).click();
            } else if (step.action === 'readTeeTimes') {
                const teeTimes = await readTeeTimes(context, course.name, selectedDate, step);
                console.log(`[${course.name}] Tee times found: ${teeTimes.length}`);
                results.push(...teeTimes.map(teeTime => ({
                    ...teeTime,
                    bookingUrl: courseUrl
                })));
            }
        }
    } catch (error) {
        console.error(`[${course.name}] ${error.message}`);
        errors.push({ course: course.name, message: error.message });
    } finally {
        await page.close();
    }

    const durationMs = Date.now() - startedAt;
    console.log(`[${course.name}] Completed in ${(durationMs / 1000).toFixed(2)}s`);
    return {
        results,
        errors,
        timing: { course: course.name, durationMs }
    };
}

async function scrapeCourseGroup(courses, selectedDate) {
    if (!courses.length) return { results: [], errors: [], timings: [] };

    const browser = await chromium.launch({
        headless: courses[0].headless === false ? false : process.env.SHOW_BROWSER !== '1'
    });
    const results = [];
    const errors = [];
    const timings = [];

    try {
        const scrapes = await Promise.all(
            courses.map(course => scrapeCourseInBrowser(browser, course, selectedDate))
        );
        results.push(...scrapes.flatMap(scrape => scrape.results));
        errors.push(...scrapes.flatMap(scrape => scrape.errors));
        timings.push(...scrapes.map(scrape => scrape.timing));
    } finally {
        await browser.close();
    }

    return { results, errors, timings };
}

async function scrapeCourse(selectedDate, requestedCourse) {
    const startedAt = Date.now();
    const data = require('./courses-steps.json');
    const courses = data.courses.filter(course => !requestedCourse || course.name === requestedCourse);
    const cityCourses = courses.filter(course => course.browserGroup === 'city');
    const independentCourses = courses.filter(course => course.browserGroup !== 'city');

    const jobs = [
        scrapeCourseGroup(cityCourses, selectedDate),
        ...independentCourses.map(course => scrapeCourseGroup([course], selectedDate))
    ];
    const scrapes = await Promise.all(jobs);

    const totalMs = Date.now() - startedAt;
    console.log(`[Search] Completed in ${(totalMs / 1000).toFixed(2)}s`);
    return {
        results: scrapes.flatMap(scrape => scrape.results),
        errors: scrapes.flatMap(scrape => scrape.errors),
        timings: {
            totalMs,
            courses: scrapes.flatMap(scrape => scrape.timings)
        }
    };
}

async function readTeeTimes(page, courseName, selectedDate, layout) {
    const results = [];
    const teeCards = page.locator(layout.cardSelector);
    const emptyState = layout.emptySelector
        ? page.locator(layout.emptySelector)
        : page.getByText(
            /no (?:available )?(?:tee )?times|no availability|nothing available|sold out/i
        );
    const rootPage = typeof page.page === 'function' ? page.page() : page;

    // A date change commonly refreshes results through XHR. Waiting for network
    // quiet prevents us from counting cards while that refresh is still in flight.
    await rootPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);

    try {
        await Promise.any([
            teeCards.first().waitFor({ state: 'visible', timeout: 15000 }),
            emptyState.first().waitFor({ state: 'visible', timeout: 15000 })
        ]);
    } catch {
        throw new Error(`${courseName}: tee-time results did not finish loading`);
    }

    if (await teeCards.count() === 0) return results;

    for (let i = 0; i < await teeCards.count(); i++) {
        const card = teeCards.nth(i);

        const time = (await card.locator(layout.timeSelector).first().innerText()).trim();
        const playersText = (await card.locator(layout.playersSelector).first().innerText()).trim();
        const playerCounts = playersText.match(/\d+/g)?.map(Number) || [];
        let priceText = '';

        if (layout.priceSelector) {
            const priceElement = card.locator(layout.priceSelector).first();
            if (await priceElement.count()) priceText = (await priceElement.innerText()).trim();
        }

        // Fall back to the complete card because provider-specific price classes change.
        if (!priceText) priceText = await card.innerText();
        let prices = readHolePrices(priceText);
        if (layout.priceRowSelector) {
            const rows = card.locator(layout.priceRowSelector);
            const byHoles = { nineHoles: null, eighteenHoles: null };
            for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex++) {
                const row = rows.nth(rowIndex);
                const cells = await row.locator('span').allInnerTexts();
                const holes = Number(cells[0]?.trim());
                const greenFee = normalizePrice(cells[1]?.match(currencyPattern)?.[0]);
                if (holes === 9) byHoles.nineHoles = greenFee;
                if (holes === 18) byHoles.eighteenHoles = greenFee;
            }
            prices = { ...byHoles, listed: byHoles.nineHoles || byHoles.eighteenHoles };
        }
        results.push({
            course: courseName,
            date: toDateInputValue(selectedDate, 'iso'),
            teeTime: time,
            players: playerCounts.length ? Math.max(...playerCounts) : null,
            price: prices.listed,
            prices: {
                nineHoles: prices.nineHoles,
                eighteenHoles: prices.eighteenHoles
            }
        });
    }

    return results;
}

function parseDateInput(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!match) return null;

    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return toDateInputValue(date, 'iso') === value ? date : null;
}

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/teetimes', async (req, res) => {
    const selectedDate = parseDateInput(req.query.date);
    if (!selectedDate) {
        return res.status(400).json({ error: 'Use a valid date in YYYY-MM-DD format.' });
    }

    try {
        const scrape = await scrapeCourse(selectedDate, req.query.course);
        return res.json({
            date: toDateInputValue(selectedDate, 'iso'),
            ...scrape
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'The tee-time search failed.' });
    }
});

app.listen(port, () => {
    console.log(`Golf Search is running at http://localhost:${port}`);
});
