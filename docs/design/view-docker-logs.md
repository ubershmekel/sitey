# Viewing docker logs

For debugging Sitey and hosted services, we need to see what's running on the
Sitey machine.

## URLs

- https://sitey.example.com/logs shows a list of all running docker containers
- https://sitey.example.com/logs/sitey-caddy-1 shows the logs for the sitey
  caddy container

## Buttons

- A button to refresh and get new logs. There is no need for automated streaming
  or refreshing.
- A select toggle to choose how much of the logs you see (100, 300, etc).
  Defaults to 100.
- A checkbox to parse json logs that defaults to off.

## Ease of use

A log line might look like:

```
{"level":"info","ts":1775376877.5306985,"msg":"got renewal info","names":["test2.redditp.com"],"window_start":1779919875,"window_end":1780075325,"selected_time":1780042859,"recheck_after":1775402770.5306866,"explanation_url":""}
```

Or

```
{"level":30,"time":1775607680011,"pid":1,"hostname":"65427bd5ab59","reqId":"req-28","res":{"statusCode":200},"responseTime":10.824864029884338,"msg":"request completed"}
```

In JSON parsed mode, we will convert "time" and "ts" to a time ago or ISO8601
and turn the data into an easy to view but still easy to copy-paste format.
