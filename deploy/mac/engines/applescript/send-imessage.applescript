-- Sends one message through Messages.app.
-- Args: recipient (phone in E.164 or an Apple ID email), body, service ("iMessage" or "SMS")
-- Kept as a file rather than an inline `osascript -e` string so a message body
-- containing quotes, newlines or backslashes can never break out into code.
on run argv
	set targetId to item 1 of argv
	set messageText to item 2 of argv
	set wantService to "iMessage"
	if (count of argv) > 2 then set wantService to item 3 of argv

	tell application "Messages"
		if wantService is "SMS" then
			set targetService to 1st service whose service type = SMS
		else
			set targetService to 1st service whose service type = iMessage
		end if
		set targetBuddy to buddy targetId of targetService
		send messageText to targetBuddy
	end tell
	return "sent"
end run
