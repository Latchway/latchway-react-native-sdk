import { z } from 'zod';

export const weatherInput = z
  .object({
    city: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe('City name, for example Singapore'),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .describe('Optional ISO 3166 two-letter country code, or null'),
  })
  .strict();

const placeSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        country: z.string().optional(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        timezone: z.string().optional(),
      }),
    )
    .optional(),
});
const forecastSchema = z.object({
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    relative_humidity_2m: z.number(),
    precipitation: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()).max(3),
    weather_code: z.array(z.number()).max(3),
    temperature_2m_max: z.array(z.number()).max(3),
    temperature_2m_min: z.array(z.number()).max(3),
    precipitation_probability_max: z.array(z.number().nullable()).max(3),
  }),
});

async function publicJSON(url: URL, signal: AbortSignal) {
  if (
    !['geocoding-api.open-meteo.com', 'api.open-meteo.com'].includes(
      url.hostname,
    ) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('Weather endpoint is not allowed.');
  }
  const abort = new AbortController();
  const relay = () => abort.abort();
  signal.addEventListener('abort', relay, { once: true });
  const timer = setTimeout(relay, 20_000);
  try {
    if (signal.aborted) abort.abort();
    const response = await fetch(url.toString(), { signal: abort.signal });
    if (!response.ok) throw new Error('Weather service is unavailable.');
    if (response.url && new URL(response.url).hostname !== url.hostname) {
      throw new Error('Unexpected weather redirect.');
    }
    const text = await response.text();
    if (text.length > 256_000)
      throw new Error('Weather response exceeds demo limit.');
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', relay);
  }
}

export async function checkWeather(input: unknown, signal: AbortSignal) {
  const args = weatherInput.parse(input);
  const search = new URL('https://geocoding-api.open-meteo.com/v1/search');
  search.searchParams.set('name', args.city);
  search.searchParams.set('count', '1');
  search.searchParams.set('language', 'en');
  if (args.countryCode)
    search.searchParams.set('countryCode', args.countryCode);
  const location = placeSchema.parse(await publicJSON(search, signal))
    .results?.[0];
  if (!location) throw new Error('City not found. Try a city and country.');
  const forecast = new URL('https://api.open-meteo.com/v1/forecast');
  forecast.searchParams.set('latitude', String(location.latitude));
  forecast.searchParams.set('longitude', String(location.longitude));
  forecast.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
  );
  forecast.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  );
  forecast.searchParams.set('forecast_days', '3');
  forecast.searchParams.set('timezone', 'auto');
  const data = forecastSchema.parse(await publicJSON(forecast, signal));
  return {
    location: location.name,
    country: location.country,
    ...data,
    units: { temperature: '°C', wind: 'km/h', precipitation: 'mm' },
    source: 'Open-Meteo / GeoNames',
    sourceURL: 'https://open-meteo.com/',
  };
}
