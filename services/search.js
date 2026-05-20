const TAVILY_KEY = process.env.TAVILY_API_KEY;

async function searchDDG(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalAI-Assistant/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const results = [];

    if (data.AbstractText) {
      results.push({
        title: data.Heading || query,
        snippet: data.AbstractText,
        url: data.AbstractURL,
      });
    }

    for (const topic of (data.RelatedTopics || []).slice(0, 4)) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.slice(0, 100),
          snippet: topic.Text,
          url: topic.FirstURL,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

async function searchTavily(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_KEY,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: true,
    }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json();
  return (data.results || []).map(r => ({
    title: r.title,
    snippet: r.content,
    url: r.url,
  }));
}

// Jina Reader: free URL-to-text converter (no API key needed)
async function fetchPageContent(url) {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'text',
        'User-Agent': 'Mozilla/5.0 (compatible; LocalAI-Assistant/1.0)',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 2500);
  } catch {
    return null;
  }
}

async function search(query, { fetchContent = false } = {}) {
  let results;

  if (TAVILY_KEY) {
    results = await searchTavily(query);
  } else {
    results = await searchDDG(query);
  }

  if (fetchContent && results.length > 0) {
    const content = await fetchPageContent(results[0].url);
    if (content) results[0].content = content;
  }

  return results;
}

module.exports = { search, fetchPageContent, searchDDG };
