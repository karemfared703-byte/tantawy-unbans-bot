# Multi-client server setup

## Discord permissions

Invite the bot with these permissions:

- View Channels
- Send Messages
- Read Message History
- Embed Links
- Attach Files
- Manage Channels
- Manage Nicknames
- Manage Messages (optional, lets the bot hide public commands after moving them to private rooms)

## Server setup

1. Create a public command channel, for example `#unban-bot`.
2. Create a category for private rooms, for example `Unban Rooms`.
3. In the public command channel, run:

```text
!quicksetup Pablo Unbans
```

Or configure it manually:

```text
!setupname Pablo Unbans
!setupchannel
!setupcategory Unban Rooms
!setupinfo
```

## User flow

Users can run:

```text
!chat
```

The bot creates a private server channel that only that user and the bot can see.

Users can then run these commands inside their private room:

```text
!t username1 username2
!stop username
!list
!clearall
!stats
!sesun 24
!support
!health
!close
!close 10m
```

If a user runs `!t username` in the public command channel, the bot will try to delete the public message and continue in that user's private room.

## Admin commands

```text
!setupname Pablo Unbans
!setup
!setupbrand name Pablo Unbans
!setupbrand color #ff0055
!setupbrand logo https://example.com/logo.png
!setupbrand roomprefix pablo-ticket
!setupbrand welcome Welcome to your private support room.
!setupbrand guide Custom guide text here
!setupbrand footer Powered by Pablo
!setupbrand error Custom error text here
!setuplogs #bot-logs
!setuprole @Customer
!setupadminrole @Admin
!setupcleanup 24
!setupcooldown 60
!setupdailyreport on
!setupdailyreport test
!setupguide #how-to-use
!setguide Custom guide text here
!setwelcome Welcome to your private room.
!setlang ar
!setcolor #ff0055
!setlogo https://example.com/logo.png
!setfooter Powered by Pablo
!setwebhook https://example.com/webhook
!exportconfig
!importconfig
!cleanup
!pause
!resume
!license info
```

Plan/license changes are owner-only:

```text
!plan info
!plan limits
!plan set pro 30d
!owner guilds
!owner stats
!owner disable <serverId>
!owner enable <serverId>
!owner extend <serverId> 30
!owner broadcast Maintenance tonight
!owner backup
!broadcast New update is live
```

## Premium features

- New servers receive an automatic trial. Configure days with `TRIAL_DAYS`.
- Plans: `trial`, `free`, `basic`, `pro`, `vip`.
- Plan limits cover users, private rooms, daily sessions, session duration, and locked features.
- Private rooms ask for a 1-5 rating before closing.
- Daily reports can be sent to the logs channel.
- Webhook events are sent for room/session/error/rating events.
- Auto backups are saved in `/data/backups`.
- Export/import copies branding/setup safely without letting clients import billing fields.

## Dashboard

Set a dashboard token:

```text
DASHBOARD_TOKEN=change_this_secret
OWNER_IDS=your_discord_user_id
OWNER_LOG_CHANNEL_ID=owner_logs_channel_id
SUPPORT_CHANNEL_ID=support_channel_id
TRIAL_DAYS=7
BACKUP_EVERY_HOURS=6
COMMAND_DELETE_SECONDS=10
```

Open:

```text
https://your-railway-domain/?token=change_this_secret
```

The dashboard shows bot status, sessions, private rooms, plans, ratings, today stats, recent operations, monitored accounts, backups path, and lets you pause/resume servers, update branding, update channels/categories by ID, manage plan days, webhook URL, cooldown, daily reports, guide/welcome messages, and language.

## Hosting persistence

The bot saves monitored accounts, server setup, and recent unbans as JSON files.
Use persistent storage on your host so those files survive redeploys.

Recommended environment variable:

```text
DATA_DIR=/data
```

On hosts such as Render, create a persistent disk and mount it at `/data`.
The bot will then save:

```text
/data/monitors.json
/data/guild-configs.json
/data/recent-unbans.json
/data/backups/backup-*.json
```

If `/data` exists, the bot uses it automatically. `DATA_DIR` is still recommended so the path is explicit.
