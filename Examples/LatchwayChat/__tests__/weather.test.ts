import { checkWeather, weatherInput } from '../src/weather';

const location = {
  results: [
    {
      name: 'Singapore',
      country: 'Singapore',
      latitude: 1.29,
      longitude: 103.85,
    },
  ],
};
const forecast = {
  timezone: 'Asia/Singapore',
  current: {
    time: '2026-09-07T12:00',
    temperature_2m: 28,
    apparent_temperature: 31,
    relative_humidity_2m: 80,
    precipitation: 0,
    weather_code: 3,
    wind_speed_10m: 9,
  },
  daily: {
    time: ['2026-09-07'],
    weather_code: [3],
    temperature_2m_max: [30],
    temperature_2m_min: [26],
    precipitation_probability_max: [40],
  },
};

afterEach(() => jest.restoreAllMocks());

test('weather schema rejects arbitrary URLs and extra execution parameters', () => {
  expect(() =>
    weatherInput.parse({
      city: 'Singapore',
      countryCode: null,
      url: 'https://evil.test',
    }),
  ).toThrow();
  expect(() => weatherInput.parse({ city: '', countryCode: null })).toThrow();
  expect(() =>
    weatherInput.parse({ city: 'Singapore', countryCode: 'ZZZ' }),
  ).toThrow();
});

test('weather invokes only fixed HTTPS services, without authentication or GPS', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(
    async input =>
      ({
        ok: true,
        url: String(input),
        text: async () =>
          JSON.stringify(
            String(input).includes('geocoding') ? location : forecast,
          ),
      } as Response),
  );
  const result = await checkWeather(
    { city: 'Singapore', countryCode: 'SG' },
    new AbortController().signal,
  );
  expect(result.current.temperature_2m).toBe(28);
  expect(result.source).toBe('Open-Meteo / GeoNames');
  expect(spy).toHaveBeenCalledTimes(2);
  expect(new URL(String(spy.mock.calls[0][0])).hostname).toBe(
    'geocoding-api.open-meteo.com',
  );
  expect(new URL(String(spy.mock.calls[1][0])).hostname).toBe(
    'api.open-meteo.com',
  );
  expect(spy.mock.calls[0][1]?.headers).toBeUndefined();
});

test('unknown cities never generate synthetic weather', async () => {
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({ ok: true, text: async () => '{}' } as Response);
  await expect(
    checkWeather(
      { city: 'Missing', countryCode: null },
      new AbortController().signal,
    ),
  ).rejects.toThrow('City not found');
  expect(spy).toHaveBeenCalledTimes(1);
});

test('network and malformed forecast errors fail closed', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);
  await expect(
    checkWeather(
      { city: 'Singapore', countryCode: null },
      new AbortController().signal,
    ),
  ).rejects.toThrow('unavailable');
});

test('weather response has a size bound', async () => {
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({
      ok: true,
      text: async () => 'x'.repeat(256001),
    } as Response);
  await expect(
    checkWeather(
      { city: 'Singapore', countryCode: null },
      new AbortController().signal,
    ),
  ).rejects.toThrow('limit');
});
