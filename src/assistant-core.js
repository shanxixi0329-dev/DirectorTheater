(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.DirectorAssistantCore=factory();})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  const names={source:'原文',outline:'大纲',script:'剧本',shotlist:'分镜',storyboard:'提示词'};
  const stageViews={source:'project',outline:'outline',script:'script',assets:'assets',shotlist:'shot-studio',storyboard:'storyboard',quality:'quality-center',review:'review'};
  function describe(c={}){
    const tasks=(c.tasks||[]).filter(t=>t.busy);
    const actions=[];
    if(tasks.length){
      const stopping=tasks.some(t=>t.stopping);
      tasks.forEach(t=>{if(t.view)actions.push({label:'查看'+t.label,target:t.view,type:'view'});if(t.show)actions.push({label:'查看进度',target:t.show,type:'action'});if(t.stop)actions.push({label:t.stopping?'已请求暂停 / 停止':t.stopLabel||'停止'+t.label,target:t.stop,type:'action',disabled:t.stopping});});
      return {mood:stopping?'stopping':'working',title:stopping?'正在结束任务':'任务正在运行',message:tasks.map(t=>t.label+(t.detail?' · '+t.detail:'')).join('；'),actions,tasks};
    }
    if(!c.project)return {mood:'idle',title:'你好，我是导导',message:'打开已有项目，或分步新建一个项目，我陪你从资料到审片。',actions:[{label:'打开项目',target:'open-projects',type:'action'},{label:'分步新建',target:'new-project',type:'action'}],tasks};
    const dirty=[...new Set(c.dirty||[])];
    if(dirty.length)return {mood:'editing',title:'有修改还没保存',message:dirty.map(x=>names[x]||x).join('、')+'仍在编辑中，保存后再进入下一步。',actions:[{label:'保存修改',target:'save',type:'local',disabled:c.readonly}],tasks};
    const stale=(c.stages||[]).filter(s=>s.status==='stale');
    const review=Number(c.reviewOpen)||0,revision=Number(c.reviewNeedsRevision)||0,issues=Number(c.issues)||0;
    if(review||revision||issues||stale.length){
      if(review||revision)actions.push({label:'查看审片意见',target:'review-notes',type:'view'});
      if(issues)actions.push({label:'查看检查问题',target:c.issueView||'quality-center',type:'view'});
      if(stale.length)actions.push({label:'复核制作阶段',target:'director-home',type:'view'});
      return {mood:'attention',title:'有内容需要你复核',message:[review?`本集有 ${review} 条未解决审片意见`:null,revision?`${revision} 个视频需要修改或复核`:null,issues?`当前检查记录有 ${issues} 项待处理`:null,stale.length?stale.map(s=>s.label||names[s.id]||s.id).join('、')+'的资料或上游内容已变化':null].filter(Boolean).join('；')+'。',actions,tasks};
    }
    const scriptReady=(c.stages||[]).some(s=>s.id==='script'&&s.status!=='missing');
    const missing=(c.stages||[]).find(s=>['missing','ready'].includes(s.status)&&!s.optional&&!(s.id==='source'&&scriptReady));
    if(missing)return {mood:'idle',title:'下一步可以做什么',message:`本集${missing.label||names[missing.id]||missing.id}${missing.status==='ready'?'已有资料，等待你核对确认。':'尚未准备好，先确认输入资料。'}`,actions:[{label:'打开'+(missing.label||names[missing.id]||missing.id),target:stageViews[missing.id]||'director-home',type:'view'},{label:'制作总览',target:'director-home',type:'view'}],tasks};
    return {mood:'idle',title:c.readonly?'当前为阅读模式':'随时帮你梳理下一步',message:c.readonly?'会员到期后可继续查看项目资料；编辑需要有效会员。':'可以逐镜调整、做内容检查或审片。是否通过，以你的检查与确认记录为准。',actions:[{label:'镜头工作台',target:'shot-studio',type:'view'},{label:'检查与优化',target:'quality-center',type:'view'},{label:'审片',target:'review',type:'view'}],tasks};
  }
  return {describe,names};
});
