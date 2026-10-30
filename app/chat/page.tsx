/** The assistant: one chat in front of the router and the three experts. ?app=<id> opens it on a job from Today. */
import { env } from '@/src/server/env';
import ChatClient from './ChatClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Assistant · Job Hunt OS' };

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ app?: string; msg?: string }> }) {
  const { app, msg } = await searchParams;
  const appId = Number(app);
  return (
    <ChatClient
      demo={env.demoMode()}
      initialAppId={Number.isInteger(appId) && appId > 0 ? appId : undefined}
      notice={msg ? msg.slice(0, 300) : undefined}
    />
  );
}
