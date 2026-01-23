import ICAL from 'ical.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncCalendars(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Manual sync trigger - requires secret token
    if (url.pathname === '/sync') {
      // Check for secret token (via header or query param)
      const token = request.headers.get('X-Sync-Token') || url.searchParams.get('token');

      if (!env.SYNC_TOKEN || token !== env.SYNC_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        const result = await syncCalendars(env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('[Calendar Sync] Error:', error.message);
        return new Response(JSON.stringify({ error: 'Sync failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Don't reveal this is a calendar sync worker
    return new Response('Not found', { status: 404 });
  },
};

async function syncCalendars(env) {
  console.log('[Calendar Sync] Starting sync...');

  const {
    OUTLOOK_ICS_URL,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
    GOOGLE_CALENDAR_ID,
  } = env;

  // Get fresh access token from refresh token
  const accessToken = await getGoogleAccessToken(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN
  );
  console.log('[Calendar Sync] Got Google access token');

  // Fetch ICS from Outlook
  const icsResponse = await fetch(OUTLOOK_ICS_URL);
  if (!icsResponse.ok) {
    console.error(`[Calendar Sync] Failed to fetch ICS: ${icsResponse.status}`);
    throw new Error(`Failed to fetch ICS: ${icsResponse.status}`);
  }
  const icsData = await icsResponse.text();
  console.log('[Calendar Sync] Fetched Outlook ICS');

  // Parse ICS
  const outlookEvents = parseICS(icsData);
  console.log(`[Calendar Sync] Parsed ${outlookEvents.length} events from Outlook`);

  // Get existing Google Calendar events (synced ones)
  const googleEvents = await getGoogleCalendarEvents(accessToken, GOOGLE_CALENDAR_ID);
  console.log(`[Calendar Sync] Found ${googleEvents.length} existing synced events in Google`);

  // Sync events
  const result = await syncEvents(
    accessToken,
    GOOGLE_CALENDAR_ID,
    outlookEvents,
    googleEvents
  );

  console.log(`[Calendar Sync] Completed: ${result.stats.created} created, ${result.stats.updated} updated, ${result.stats.deleted} deleted, ${result.stats.unchanged} unchanged`);

  return result;
}

function mapResponseStatus(partstat) {
  const map = {
    'ACCEPTED': 'accepted',
    'DECLINED': 'declined',
    'TENTATIVE': 'tentative',
    'NEEDS-ACTION': 'needsAction',
  };
  return map[partstat] || 'needsAction';
}

function parseICS(icsData) {
  const jcalData = ICAL.parse(icsData);
  const vcalendar = new ICAL.Component(jcalData);
  const vevents = vcalendar.getAllSubcomponents('vevent');

  return vevents.map((vevent) => {
    const event = new ICAL.Event(vevent);

    // Extract attendees
    const attendees = vevent.getAllProperties('attendee').map((attendee) => {
      const email = attendee.getFirstValue()?.replace('mailto:', '') || '';
      const cn = attendee.getParameter('cn') || email;
      const partstat = attendee.getParameter('partstat') || 'NEEDS-ACTION';
      return { email, displayName: cn, responseStatus: mapResponseStatus(partstat) };
    }).filter(a => a.email);

    // Extract organizer
    const organizerProp = vevent.getFirstProperty('organizer');
    const organizer = organizerProp ? {
      email: organizerProp.getFirstValue()?.replace('mailto:', '') || '',
      displayName: organizerProp.getParameter('cn') || '',
    } : null;

    return {
      uid: event.uid,
      summary: event.summary || '(No title)',
      description: event.description || '',
      location: event.location || '',
      start: event.startDate.toJSDate().toISOString(),
      end: event.endDate.toJSDate().toISOString(),
      isAllDay: event.startDate.isDate,
      lastModified: vevent.getFirstPropertyValue('last-modified')?.toJSDate()?.toISOString() ||
                    vevent.getFirstPropertyValue('dtstamp')?.toJSDate()?.toISOString(),
      attendees,
      organizer,
    };
  });
}

async function getGoogleAccessToken(clientId, clientSecret, refreshToken) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get access token: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function getGoogleCalendarEvents(accessToken, calendarId) {
  // Get events from the last 30 days to 1 year in the future
  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 30);
  const timeMax = new Date();
  timeMax.setFullYear(timeMax.getFullYear() + 1);

  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    maxResults: '2500',
    singleEvents: 'false',
  });

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Google events: ${error}`);
  }

  const data = await response.json();
  return data.items || [];
}

async function syncEvents(accessToken, calendarId, outlookEvents, googleEvents) {
  const stats = { created: 0, updated: 0, deleted: 0, unchanged: 0 };

  // Create a map of Google events by Outlook UID
  const googleEventsByUid = new Map();
  for (const event of googleEvents) {
    const uid = event.extendedProperties?.private?.outlookSyncUid;
    if (uid) {
      googleEventsByUid.set(uid, event);
    }
  }

  // Track which Outlook UIDs we've seen
  const seenUids = new Set();

  // Process each Outlook event
  for (const outlookEvent of outlookEvents) {
    seenUids.add(outlookEvent.uid);
    const existingGoogleEvent = googleEventsByUid.get(outlookEvent.uid);

    const googleEventBody = {
      summary: outlookEvent.summary,
      description: outlookEvent.description,
      location: outlookEvent.location,
      extendedProperties: {
        private: {
          outlookSyncUid: outlookEvent.uid,
          outlookLastModified: outlookEvent.lastModified,
        },
      },
    };

    // Add attendees if present
    if (outlookEvent.attendees && outlookEvent.attendees.length > 0) {
      googleEventBody.attendees = outlookEvent.attendees;
    }

    // Add organizer if present
    if (outlookEvent.organizer && outlookEvent.organizer.email) {
      googleEventBody.organizer = outlookEvent.organizer;
    }

    // Handle all-day vs timed events
    if (outlookEvent.isAllDay) {
      googleEventBody.start = { date: outlookEvent.start.split('T')[0] };
      googleEventBody.end = { date: outlookEvent.end.split('T')[0] };
    } else {
      googleEventBody.start = { dateTime: outlookEvent.start };
      googleEventBody.end = { dateTime: outlookEvent.end };
    }

    if (!existingGoogleEvent) {
      // Create new event
      await createGoogleEvent(accessToken, calendarId, googleEventBody);
      console.log(`[Calendar Sync] Created: "${outlookEvent.summary}" (${outlookEvent.start})`);
      stats.created++;
    } else {
      // Check if update needed
      const existingLastModified = existingGoogleEvent.extendedProperties?.private?.outlookLastModified;
      if (existingLastModified !== outlookEvent.lastModified || hasEventChanged(existingGoogleEvent, googleEventBody)) {
        await updateGoogleEvent(accessToken, calendarId, existingGoogleEvent.id, googleEventBody);
        console.log(`[Calendar Sync] Updated: "${outlookEvent.summary}" (${outlookEvent.start})`);
        stats.updated++;
      } else {
        stats.unchanged++;
      }
    }
  }

  // Delete events that no longer exist in Outlook
  for (const [uid, googleEvent] of googleEventsByUid) {
    if (!seenUids.has(uid)) {
      await deleteGoogleEvent(accessToken, calendarId, googleEvent.id);
      console.log(`[Calendar Sync] Deleted: "${googleEvent.summary}"`);
      stats.deleted++;
    }
  }

  return { stats, timestamp: new Date().toISOString() };
}

function hasEventChanged(googleEvent, newEventBody) {
  return (
    googleEvent.summary !== newEventBody.summary ||
    googleEvent.description !== newEventBody.description ||
    googleEvent.location !== newEventBody.location
  );
}

async function createGoogleEvent(accessToken, calendarId, eventBody) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventBody),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error(`Failed to create event: ${error}`);
  }
}

async function updateGoogleEvent(accessToken, calendarId, eventId, eventBody) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventBody),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error(`Failed to update event: ${error}`);
  }
}

async function deleteGoogleEvent(accessToken, calendarId, eventId) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    console.error(`Failed to delete event: ${error}`);
  }
}
