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
```

If a user runs `!t username` in the public command channel, the bot will try to delete the public message and continue in that user's private room.

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
```

If `/data` exists, the bot uses it automatically. `DATA_DIR` is still recommended so the path is explicit.
