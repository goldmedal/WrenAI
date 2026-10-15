import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/app/theme/ThemeProvider';
import { NativeScopedSession } from '../NativeScopedSession';
import { saveNativeSessionCapability } from '../capability';
vi.mock('@/bff/env', () => ({ bffBaseUrl: () => '', isBffEnabled: () => true }));
vi.mock('@/envelope/EnvelopeView', () => ({ EnvelopeView: () => <div>Verified query table</div> }));
class Socket {
  static OPEN=1; static instances: Socket[]=[]; readyState=1;
  onmessage?: (event: {data:string})=>void; onclose?:()=>void; onerror?:()=>void;
  send=vi.fn(); close=vi.fn(); constructor(readonly url:string){Socket.instances.push(this);}
  frame(frame:unknown){this.onmessage?.({data:JSON.stringify(frame)});}
}
const callbacks={onExit:vi.fn(),onConnected:vi.fn(),onConnectionLost:vi.fn()};
const event=(sequence:number,kind:string,payload:unknown)=>({type:'event',sequence,requestId:'root',kind,payload});
beforeEach(()=>{Socket.instances=[];sessionStorage.clear();Object.values(callbacks).forEach(fn=>fn.mockReset());vi.stubGlobal('WebSocket',Socket);saveNativeSessionCapability('session','cap');});
afterEach(()=>vi.unstubAllGlobals());
it('replays ordered events, deduplicates frames, shows progress/refusal and reconnects with the last cursor without relaunching',async()=>{
  const renderSession=(nonce:number)=><ThemeProvider><NativeScopedSession sessionId="session" reconnectNonce={nonce} {...callbacks}/></ThemeProvider>;
  const view=render(renderSession(0));const ws=Socket.instances[0]!;
  expect(ws.url).toContain('/scoped-events');expect(ws.url).toContain('after=0');
  act(()=>ws.frame({type:'replay',through:2,floor:1,truncated:false,state:'ready',events:[event(1,'user',{text:'count orders'}),event(2,'answer',{answer:{form:'rich',envelope:{}}})]}));
  expect(await screen.findByText('Verified query table')).toBeInTheDocument(); expect(callbacks.onConnected).toHaveBeenCalledOnce();
  act(()=>ws.frame(event(2,'answer',{answer:{form:'rich',envelope:{}}})));expect(screen.getAllByText('Verified query table')).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox',{name:'Question for scoped analysis'}),{target:{value:'count again'}});fireEvent.click(screen.getByRole('button',{name:'Send question'}));
  expect(JSON.parse(ws.send.mock.calls[0]![0])).toMatchObject({type:'prompt',text:'count again',requestId:expect.any(String)});
  act(()=>ws.frame(event(3,'state',{state:'running'})));
  act(()=>ws.frame(event(4,'worklog',{steps:[{id:'query',kind:'tool',label:'Read-only query',state:'running'}]})));
  expect(screen.getByText('Read-only query')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Cancel response'}));expect(ws.send).toHaveBeenLastCalledWith('{"type":"cancel"}');
  act(()=>ws.onclose?.());expect(callbacks.onConnectionLost).toHaveBeenCalledOnce();expect(screen.getByText(/Browser disconnected/)).toBeInTheDocument();
  view.rerender(renderSession(1));const reconnected=Socket.instances[1]!;expect(reconnected.url).toContain('after=4');expect(ws.close).toHaveBeenCalledOnce();
  act(()=>reconnected.frame({type:'replay',through:6,floor:1,truncated:false,state:'ready',events:[event(5,'refusal',{reason:'Cannot query this dataset',fix:'Use a supported query'}),event(6,'state',{state:'ready'})]}));
  expect(screen.getByText('Cannot query this dataset')).toBeInTheDocument();expect(screen.getByText('Use a supported query')).toBeInTheDocument();expect(reconnected.send).not.toHaveBeenCalled();
  expect(screen.getAllByText('Verified query table')).toHaveLength(1);expect(screen.getByRole('textbox',{name:'Question for scoped analysis'})).toBeEnabled();
});
it('fresh reload displays a retention gap and interrupted cleanup distinctly; malformed/out-of-order replay closes the stream',()=>{
  render(<ThemeProvider><NativeScopedSession sessionId="session" reconnectNonce={0} {...callbacks}/></ThemeProvider>);const ws=Socket.instances[0]!;
  act(()=>ws.frame({type:'replay',through:600,floor:89,truncated:true,state:'interrupted',events:[event(600,'state',{state:'interrupted',cleanup:'confirmed'})]}));
  expect(screen.getByText(/earlier events were truncated/)).toBeInTheDocument();expect(callbacks.onExit).toHaveBeenCalledWith(1);expect(screen.getByRole('textbox',{name:'Question for scoped analysis'})).toBeDisabled();
  act(()=>ws.frame({type:'replay',through:601,floor:89,truncated:true,state:'ready',events:[]}));expect(ws.close).toHaveBeenCalledOnce();expect(screen.getByText(/session stream is invalid/)).toBeInTheDocument();
});
it('history-only browser can read saved events and cannot acquire an attachment or submit',async()=>{
  sessionStorage.clear();vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({type:'replay',through:1,floor:1,truncated:false,state:'stopped',events:[event(1,'user',{text:'Saved question'})]})})));
  render(<ThemeProvider><NativeScopedSession sessionId="session" reconnectNonce={0} readOnly {...callbacks}/></ThemeProvider>);
  await waitFor(()=>expect(screen.getByText('Saved question')).toBeInTheDocument());expect(Socket.instances).toHaveLength(0);expect(screen.getByRole('button',{name:'Send question'})).toBeDisabled();
});
