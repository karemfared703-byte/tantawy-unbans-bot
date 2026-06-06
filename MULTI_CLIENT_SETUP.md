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
