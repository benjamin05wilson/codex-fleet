// Only for the isolated public-page diagnostic. Never installed in user pages.
export async function profileNativeScroll(web, window, app) {
  console.log(
    JSON.stringify({
      gpu: app.getGPUFeatureStatus(),
      chrome: process.versions.chrome,
    }),
  );
  window.focus();
  web.focus();
  for (const top of [0, 1800, 4200, 7200]) {
    await web.executeJavaScript(`scrollTo({top:${top},behavior:'instant'})`);
    await new Promise((r) => setTimeout(r, 500));
    const start = await web.executeJavaScript(`(() => {
      const p={frames:[],tasks:[],longFrames:[],observers:[]};window.fleetScrollProfile=p;
      function tick(at){p.frames.push({at,y:scrollY});p.raf=requestAnimationFrame(tick);}p.raf=requestAnimationFrame(tick);
      for(const type of ['longtask','long-animation-frame']) {
        if(!PerformanceObserver.supportedEntryTypes.includes(type))continue;
        const observer=new PerformanceObserver(list=>{for(const e of list.getEntries()) {
          const value={duration:e.duration,blocking:e.blockingDuration,layout:e.styleAndLayoutStart&&e.startTime+e.duration-e.styleAndLayoutStart};
          if(e.scripts)value.scripts=e.scripts.slice(0,5).map(s=>({duration:s.duration,invoker:s.invokerType,function:s.sourceFunctionName,source:s.sourceURL ? new URL(s.sourceURL,location.href).pathname : ''}));
          (type==='longtask'?p.tasks:p.longFrames).push(value);
        }});observer.observe({type});p.observers.push(observer);
      }
      return {y:scrollY,headings:Array.from(document.querySelectorAll('h1,h2')).filter(e=>{const r=e.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight;}).map(e=>e.textContent.trim().slice(0,100))};
    })()`);
    for (let i = 0; i < 100; i++) {
      web.sendInputEvent({
        type: "mouseWheel",
        x: 500,
        y: 400,
        deltaX: 0,
        deltaY: -24,
        hasPreciseScrollingDeltas: true,
      });
      await new Promise((r) => setTimeout(r, 16));
    }
    await new Promise((r) => setTimeout(r, 150));
    const p = await web.executeJavaScript(
      `(() => {const p=window.fleetScrollProfile;cancelAnimationFrame(p.raf);p.observers.forEach(o=>o.disconnect());delete window.fleetScrollProfile;return {frames:p.frames,tasks:p.tasks,longFrames:p.longFrames,y:scrollY};})()`,
    );
    const gaps = p.frames
      .slice(1)
      .map((f, i) => f.at - p.frames[i].at)
      .sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        start,
        end: p.y,
        callbacks: p.frames.length,
        gapMedian: gaps[Math.floor(gaps.length * 0.5)],
        gapP95: gaps[Math.floor(gaps.length * 0.95)],
        maxGap: Math.max(...gaps),
        over33ms: gaps.filter((g) => g > 33.5).length,
        longTasks: p.tasks.sort((a, b) => b.duration - a.duration).slice(0, 4),
        longFrames: p.longFrames
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 4),
      }),
    );
  }
}
