<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="tools/readme-header/paratrooper-header-dark.png">
    <img alt="Paratrooper" src="tools/readme-header/paratrooper-header-light.png" width="320">
  </picture>
</p>

## About

Paratrooper allows you to interact with your agent on the cloud
using ~~an iMessage-like~~ a familiar messaging interface. 

Once you set up your agent on the cloud, you can access the texting interface as a PWA on your iphone. The PWA is modeled after modern text messaging applications and comes with notification support.

I use my modified version of the paratrooper to update the [pin board on my website](https://theonetrueakash.com/). You can use the installation script to set up a basic chat agent, or modify it further for personal automations. 

## Features

- **Phone interface:** An installable iPhone PWA with a familiar messaging layout and push notifications.
- **Photos and web:** Send photos for the agent to examine, or ask it to search the web and read pages.
- **Self-hosted setup:** An installer deploys your personal chat instance in your own Render workspace.
- **Worker sleeping:** Optionally suspend the worker when idle and wake it for new messages, reducing active worker time.

## Set up

The fastest way to set up your paratrooper is by cloning the repo and running the installation command:
```
git clone {gh repo link}
./install.sh
```
The basic version will run a headless claude code instance on Render. You need not have anything pre-installed; the installer will walk you through the whole set up even if you do not have python, Claude Code, or a Render account.

You are encouraged to customize your set up by providing the agent with custom tools or plugging it into existing automations. 

Once the backend portion is wired up, visit your server's address, and you will see the following page:

INSERT GIF 

After adding the paratrooper web app to your home screen, you will be able to access and use it like any other application:

INSERT GIF

(Currently there is no pre-existing backend set up for self-hosting on non-Render servers, but that will be included in the next release.)

## Example use cases

## Cost, limitations, and future updates

## Security

## License

Paratrooper is released under the [Paratrooper License 1.0.0](LICENSE.md). It is source-available, not open source: personal, non-commercial use is permitted, the source may be shared with changes, and the software or works based on it may not otherwise be distributed.
