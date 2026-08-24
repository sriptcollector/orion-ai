# Your AI assistant

It finds people worth talking to, writes the first message, and posts for you —
and it checks with you before anything goes out.

You run it from Telegram. The Mac just needs to stay on.

## The one rule

**Nothing sends until you tap ✅.**

Every text, every Reddit post, every social post arrives in your Telegram as a draft
first. You approve it, rewrite it, or skip it. Nothing goes out under your name or
your phone number without you seeing it exactly as it will appear.

## Getting started

```bash
cd ~/orion-ai/deploy/mac
npm run setup
```

That opens the setup screen: keys, account logins, 24/7 mode, and a full check that
everything works.

## What to type in Telegram

**Finding people**
```
/scrape                       sweep LinkedIn now
/target head of ops logistics add a search to the 24/7 rotation
/leads                        newest leads, tap one to draft a text
```

**Reaching out** — all of these draft, none of them send
```
/text +13105551212 <what you want to say>
/post x <topic>               also: linkedin, threads, facebook, instagram
/reddit smallbusiness <topic> written to fit that subreddit's rules
/inbox                        replies that came in
/pending                      everything waiting on your tap
```

**Control**
```
/status        health of everything
/services      every system: Tailscale, remote desktop, LinkedIn,
               Reddit, WhatsApp, socials, jobs, chatbot
/pause         stop everything
/resume        start again
/hours 8 22    when it's allowed to act
/brief <...>   describe your business — this drives every draft
/logins        which accounts are still signed in
```

**Help**
```
/orion <message>    texts Orion directly
```

## Checking it from anywhere

Option `1` in the setup screen shows every system as green, amber or red —
Tailscale, Chrome Remote Desktop, the Telegram bridge, LinkedIn, Reddit,
WhatsApp, each social account, the scheduler and the chatbot.

The same board is a web page you can open from your phone:

```bash
npm run status
```

With Tailscale installed it's reachable from any of your devices, anywhere,
without exposing anything to the public internet. The link and its access token
are printed when it starts, and it runs automatically once 24/7 mode is on.

## Set your brief. Really.

`/brief` is the difference between messages people reply to and messages people
delete. Everything the assistant writes is written against it.

Not this:
> we do consulting

This:
> We do fractional ops for 20-60 person logistics companies. Most of our clients
> come to us drowning in spreadsheets after a growth spurt. We're cheaper than a
> full-time ops hire and we're usually done in 90 days. We don't do software.

Change it any time — the next draft picks it up.

## Why it goes slowly on purpose

LinkedIn restricts accounts that behave like scrapers, and Reddit shadowbans accounts
that post too often — a shadowban is invisible from the inside, so your posts look
fine to you and are shown to nobody.

So there are hard limits: a daily ceiling on profiles, real gaps between actions, a
minimum wait per subreddit, and a window of hours it's allowed to act at all. If
LinkedIn ever shows a security check, the assistant stops itself and tells you rather
than pushing through.

It'll feel slow. That's the setting that keeps the accounts alive.

## If something looks wrong

`/status` first — it usually says why. Paused, outside active hours, or a login
expired covers almost everything.

Otherwise `/orion <what's happening>`, or option `6` in the setup screen. That reaches
Orion's phone with your system status attached.
