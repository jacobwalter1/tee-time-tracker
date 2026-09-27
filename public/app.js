const courseNames = [
  'Jester Park', 'Waveland', 'Bright Grandview', 'Blank',
  'Otter Creek', 'The Legacy', 'Terrace Hills'
];

const form = document.querySelector('#search-form');
const dateInput = document.querySelector('#date');
const courseFilter = document.querySelector('#course-filter');
const playersFilter = document.querySelector('#players-filter');
const startFilter = document.querySelector('#start-filter');
const endFilter = document.querySelector('#end-filter');
const clearFilters = document.querySelector('#clear-filters');
const resultsElement = document.querySelector('#results');
const statusElement = document.querySelector('#status');
const errorsElement = document.querySelector('#course-errors');
const resultKicker = document.querySelector('#result-kicker');
const resultTitle = document.querySelector('#result-title');
const resultsSection = document.querySelector('.results-section');
const submitButton = form.querySelector('button[type="submit"]');
const cardTemplate = document.querySelector('#tee-time-template');
let teeTimes = [];
let searchDurationMs = null;

function localIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function addTimeOptions(select, firstLabel) {
  select.append(new Option(firstLabel, ''));
  for (let hour = 5; hour <= 21; hour += 1) {
    const suffix = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    select.append(new Option(displayHour + ':00 ' + suffix, String(hour * 60)));
  }
}

function minutesFromTime(value) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value.trim());
  if (!match) return 0;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return hour * 60 + Number(match[2]);
}

function readableDate(value) {
  const parts = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  }).format(new Date(parts[0], parts[1] - 1, parts[2]));
}

function formatDuration(milliseconds) {
  return (milliseconds / 1000).toFixed(1) + 's';
}

function renderResults() {
  const course = courseFilter.value;
  const players = Number(playersFilter.value);
  const earliest = Number(startFilter.value || 0);
  const latest = Number(endFilter.value || 24 * 60);
  const filtered = teeTimes
    .filter(item => !course || item.course === course)
    .filter(item => !players || (item.players || 0) >= players)
    .filter(item => {
      const minutes = minutesFromTime(item.teeTime);
      return minutes >= earliest && minutes <= latest;
    })
    .sort((a, b) => minutesFromTime(a.teeTime) - minutesFromTime(b.teeTime));

  resultsElement.replaceChildren();
  const resultState = teeTimes.length ? 'LIVE AVAILABILITY' : 'NO AVAILABILITY';
  resultKicker.textContent = searchDurationMs === null
    ? resultState
    : resultState + ' - ' + formatDuration(searchDurationMs);
  resultTitle.textContent = filtered.length + ' tee time' + (filtered.length === 1 ? '' : 's') + ' found';
  statusElement.hidden = teeTimes.length > 0;

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = teeTimes.length
      ? 'No tee times match these filters. Try widening your search.'
      : 'No available tee times were returned for this date.';
    resultsElement.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const teeTime of filtered) {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    card.href = teeTime.bookingUrl;
    const nineHolePrice = teeTime.prices?.nineHoles;
    const eighteenHolePrice = teeTime.prices?.eighteenHoles;
    const priceLabel = [
      nineHolePrice && '9 holes ' + nineHolePrice,
      eighteenHolePrice && '18 holes ' + eighteenHolePrice
    ].filter(Boolean).join(', ');
    card.setAttribute('aria-label', 'Book ' + teeTime.teeTime + ' at ' + teeTime.course +
      (priceLabel ? ', ' + priceLabel : teeTime.price ? ' for ' + teeTime.price : ''));
    card.querySelector('.card-course').textContent = teeTime.course;
    card.querySelector('.card-time').textContent = teeTime.teeTime;
    card.querySelector('.card-players').textContent = teeTime.players
      ? teeTime.players + ' spot' + (teeTime.players === 1 ? '' : 's') + ' open'
      : 'Availability listed';
    const priceElement = card.querySelector('.card-price');
    priceElement.textContent = priceLabel || teeTime.price || 'Price unavailable';
    priceElement.classList.toggle('unavailable', !priceLabel && !teeTime.price);
    fragment.append(card);
  }
  resultsElement.append(fragment);
}

async function search(date) {
  teeTimes = [];
  searchDurationMs = null;
  resultsElement.replaceChildren();
  errorsElement.hidden = true;
  statusElement.hidden = false;
  statusElement.classList.add('loading');
  statusElement.textContent = 'Checking all seven courses. ForeUp courses may briefly open browser windows…';
  resultKicker.textContent = 'SEARCHING';
  resultTitle.textContent = readableDate(date);
  resultsSection.setAttribute('aria-busy', 'true');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/teetimes?date=' + encodeURIComponent(date));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Search failed.');
    teeTimes = payload.results || [];
    searchDurationMs = payload.timings?.totalMs ?? null;
    if (payload.errors && payload.errors.length) {
      errorsElement.hidden = false;
      errorsElement.textContent = 'Some courses could not be checked: ' +
        payload.errors.map(error => error.course).join(', ') + '.';
    }
    renderResults();
  } catch (error) {
    resultKicker.textContent = 'SEARCH ERROR';
    resultTitle.textContent = 'Could not load tee times';
    statusElement.hidden = false;
    statusElement.textContent = error.message;
  } finally {
    statusElement.classList.remove('loading');
    resultsSection.setAttribute('aria-busy', 'false');
    submitButton.disabled = false;
  }
}

for (const course of courseNames) courseFilter.append(new Option(course, course));
addTimeOptions(startFilter, 'Any time');
addTimeOptions(endFilter, 'Any time');
dateInput.value = localIsoDate(new Date());
dateInput.min = localIsoDate(new Date());

form.addEventListener('submit', event => {
  event.preventDefault();
  if (dateInput.value) search(dateInput.value);
});
for (const filter of [courseFilter, playersFilter, startFilter, endFilter]) {
  filter.addEventListener('change', renderResults);
}
clearFilters.addEventListener('click', () => {
  courseFilter.value = '';
  playersFilter.value = '0';
  startFilter.value = '';
  endFilter.value = '';
  if (teeTimes.length) renderResults();
});
