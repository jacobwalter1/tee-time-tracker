function isoDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function maxPlayers(text) {
    const counts = text.match(/\d+/g)?.map(Number) || [];
    return counts.length ? Math.max(...counts) : null;
}

function priceRange(text) {
    const prices = [...text.matchAll(/\$\s*\d+(?:\.\d{2})?/g)].map(match => match[0].replace(/\s+/g, ''));
    return [...new Set(prices)].join('–') || null;
}

function result(course, date, time, players, price, bookingUrl) {
    return {
        course: course.name,
        date: isoDate(date),
        teeTime: time.trim(),
        players,
        price,
        prices: { nineHoles: null, eighteenHoles: null },
        bookingUrl
    };
}

async function clubCaddie(page, course, date) {
    const bookingUrl = course.clubCaddieDirect
        ? new URL(course.url)
        : new URL('https://toadvalleygolfcourse.com/book-now/');
    if (course.clubCaddieDirect) {
        const dateText = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`;
        bookingUrl.pathname += '/slots';
        bookingUrl.search = new URLSearchParams({ date: dateText, player: '4', ratetype: 'any' }).toString();
    } else {
        bookingUrl.search = new URLSearchParams({
            course: course.clubCaddieCourse,
            date: isoDate(date),
            players: '4',
            holes: '18',
            pref: 'earliest'
        }).toString();
    }
    await page.goto(bookingUrl.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const findFrame = () => page.frames().find(item => item.url().includes('apimanager-cc18.clubcaddie.com/webapi/view/') && item.url().includes('/slots'));
    const frame = course.clubCaddieDirect ? page : findFrame() || await page.waitForEvent('framenavigated', {
        predicate: item => item.url().includes('apimanager-cc18.clubcaddie.com/webapi/view/') && item.url().includes('/slots'),
        timeout: 20000
    }).catch(findFrame);
    if (!frame) throw new Error('Club Caddie tee sheet did not load');
    await frame.locator('.teetime.bigscreen').first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => null);
    const rows = frame.locator('.teetime.bigscreen');
    if (!await rows.count()) {
        const body = await frame.locator('body').innerText();
        if (/no (?:tee )?times|no availability|use time & day filters/i.test(body)) return [];
        throw new Error('Club Caddie returned no readable tee times');
    }
    const data = await rows.evaluateAll(nodes => nodes.map(node => ({
        time: node.querySelector('.tt-label')?.textContent?.match(/\b\d{1,2}:\d{2}\s*[AP]M\b/i)?.[0],
        players: node.querySelector('.tt-golfers')?.textContent || '',
        price: node.querySelector('.tt-price')?.textContent || ''
    })).filter(item => item.time));
    return data.map(item => result(course, date, item.time, maxPlayers(item.players), priceRange(item.price), bookingUrl.href));
}

async function teeItUp(page, course, date) {
    const bookingUrl = new URL(course.url);
    bookingUrl.search = new URLSearchParams({ course: course.teeItUpCourse, date: isoDate(date), max: '999999' }).toString();
    await page.goto(bookingUrl.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const tiles = page.getByTestId('teetimes-tile-time');
    await tiles.first().waitFor({ state: 'visible', timeout: 18000 }).catch(() => null);
    if (!await tiles.count()) {
        const body = await page.locator('body').innerText();
        if (/no (?:available )?(?:tee )?times|0 tee times|no availability/i.test(body)) return [];
        throw new Error('TeeItUp returned no readable tee times');
    }
    const data = await tiles.evaluateAll(nodes => nodes.map(node => {
        const card = node.closest('[role="group"]');
        return {
            time: node.textContent,
            players: card?.querySelector('[data-testid="teetimes-tile-available-players"]')?.textContent || '',
            price: card?.textContent || ''
        };
    }));
    return data.map(item => result(course, date, item.time, maxPlayers(item.players), priceRange(item.price), bookingUrl.href));
}

async function chronoGolf(page, course, date) {
    await page.goto(course.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const findFrame = () => page.frames().find(item => item.url().includes('/club/3286/widget'));
    const frame = findFrame() || await page.waitForEvent('framenavigated', {
        predicate: item => item.url().includes('/club/3286/widget'),
        timeout: 15000
    }).catch(findFrame);
    if (!frame) throw new Error('Chronogolf booking widget did not load');
    const month = date.toLocaleDateString('en-US', { month: 'long' });
    const dayLabel = `${month} ${date.getDate()}, ${date.getFullYear()}`;
    for (let attempt = 0; attempt < 13; attempt++) {
        const dayButton = frame.getByRole('button', { name: dayLabel, exact: true });
        if (await dayButton.count()) {
            await dayButton.click();
            break;
        }
        if (attempt === 12) throw new Error('Date is outside the Chronogolf calendar');
        await frame.getByRole('button', { name: 'Next month' }).click();
    }
    await frame.getByText('18 holes', { exact: true }).last().click();
    await frame.getByRole('button', { name: 'Continue' }).click();
    await frame.getByText('4', { exact: true }).last().click();
    await frame.getByRole('button', { name: 'Continue' }).click();
    const rows = frame.locator('booking-widget-teetime');
    await rows.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
    if (!await rows.count()) {
        const body = await frame.locator('body').innerText();
        if (/no (?:available )?(?:tee )?times|no availability/i.test(body)) return [];
        throw new Error('Chronogolf returned no readable tee times');
    }
    const data = await rows.evaluateAll(nodes => nodes.map(node => ({
        time: node.querySelector('.widget-teetime-tag')?.textContent?.trim(),
        price: node.querySelector('.widget-teetime-total')?.textContent?.trim() || null
    })).filter(item => /^\d{1,2}:\d{2}\s*[AP]M$/i.test(item.time || '')));
    const bookingUrl = `${course.url}#teetimes`;
    return data.map(item => result(course, date, item.time, 4, item.price, bookingUrl));
}

async function scrapeBookingProvider(page, course, date) {
    if (course.scraper === 'clubCaddie') return clubCaddie(page, course, date);
    if (course.scraper === 'teeItUp') return teeItUp(page, course, date);
    if (course.scraper === 'chronoGolf') return chronoGolf(page, course, date);
    throw new Error(`Unknown booking provider: ${course.scraper}`);
}

module.exports = { scrapeBookingProvider };
