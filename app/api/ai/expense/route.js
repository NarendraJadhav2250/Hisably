import { createClient } from '@supabase/supabase-js';

const MAX_TEXT_LENGTH = 1200;

export async function POST(request) {
  const apiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!apiKey || !supabaseUrl || !supabaseAnonKey) {
    return Response.json({ error: 'AI parsing is not configured on this deployment.' }, { status: 503 });
  }

  const authorization = request.headers.get('authorization') || '';
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return Response.json({ error: 'Sign in to use the expense assistant.' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request must contain valid JSON.' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_TEXT_LENGTH || typeof body.groupId !== 'string') {
    return Response.json({ error: `Enter an expense description under ${MAX_TEXT_LENGTH} characters.` }, { status: 400 });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: authError } = await supabase.auth.getUser(accessToken);
  if (authError || !userData.user) return Response.json({ error: 'Your session has expired. Sign in again.' }, { status: 401 });

  const { data: membership, error: membershipError } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('group_id', body.groupId)
    .eq('user_id', userData.user.id)
    .eq('membership_status', 'active')
    .maybeSingle();
  if (membershipError || !membership) return Response.json({ error: 'You do not have access to this group.' }, { status: 403 });

  const { data: members, error: membersError } = await supabase
    .from('group_members')
    .select('display_name')
    .eq('group_id', body.groupId)
    .eq('membership_status', 'active');
  if (membersError) return Response.json({ error: 'Could not load this group’s members.' }, { status: 500 });

  const memberNames = (members || []).map((member) => member.display_name).filter(Boolean);
  const prompt = `Extract one shared expense from the user's text. Return JSON only with keys: title (string), amount (number in major currency units), currency (three-letter code), payer (string name), participants (array of string names), splitMethod (equal|exact|percentage|shares), category (string), date (YYYY-MM-DD or null), notes (string or null). Do not invent missing amounts or people; use null/empty values and ask for clarification in the clarification field if essential information is missing. The authorized group member names are: ${JSON.stringify(memberNames)}. Use only these names when a person is identifiable. Do not return IDs. User text: ${JSON.stringify(text)}`;

  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return Response.json({ error: 'The AI service could not be reached. Try again shortly.' }, { status: 502 });
  }
  if (!response.ok) return Response.json({ error: 'The AI service could not parse that expense right now.' }, { status: 502 });

  let parsed;
  try {
    const result = await response.json();
    const generatedText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    parsed = JSON.parse(generatedText);
  } catch {
    return Response.json({ error: 'The AI returned an unreadable response. Please enter the expense manually.' }, { status: 502 });
  }

  const allowedCategories = new Set([
    'Food & Dining', 'Groceries', 'Travel', 'Transportation', 'Accommodation', 'Shopping',
    'Entertainment', 'Utilities', 'Rent', 'Medical', 'Education', 'Other',
  ]);
  const amount = typeof parsed.amount === 'number' && Number.isFinite(parsed.amount) && parsed.amount > 0 ? parsed.amount : null;
  return Response.json({
    expense: {
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 160) : '',
      amount,
      currency: typeof parsed.currency === 'string' && /^[A-Z]{3}$/.test(parsed.currency) ? parsed.currency : 'INR',
      payer: typeof parsed.payer === 'string' ? parsed.payer.slice(0, 100) : '',
      participants: Array.isArray(parsed.participants) ? parsed.participants.filter((name) => typeof name === 'string').slice(0, 100) : [],
      splitMethod: ['equal', 'exact', 'percentage', 'shares'].includes(parsed.splitMethod) ? parsed.splitMethod : 'equal',
      category: allowedCategories.has(parsed.category) ? parsed.category : 'Other',
      date: typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : '',
      notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 500) : '',
      clarification: typeof parsed.clarification === 'string' ? parsed.clarification.slice(0, 240) : '',
    },
  });
}