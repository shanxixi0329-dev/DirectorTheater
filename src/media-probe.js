const fs=require('fs');
const fsp=require('fs/promises');
const path=require('path');
const crypto=require('crypto');
const {execFile}=require('child_process');
async function fileHash(file){const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
async function probe(file,binary){
 const absolute=path.resolve(file),stat=await fsp.stat(absolute);if(!stat.isFile())throw Error('请选择视频文件。');
 const json=await new Promise((resolve,reject)=>execFile(binary,['-v','error','-show_format','-show_streams','-of','json',absolute],{windowsHide:true,maxBuffer:8*1024*1024,timeout:60000,env:{...process.env,PATH:path.dirname(binary)+path.delimiter+process.env.PATH}},(e,out)=>e?reject(Error('视频探测失败：'+e.message)):resolve(out)));
 const data=JSON.parse(json),video=data.streams?.find(s=>s.codec_type==='video');if(!video)throw Error('文件没有视频流。');
 const duration=Number(data.format?.duration||video.duration);if(!Number.isFinite(duration)||duration<=0)throw Error('无法确定真实视频时长。');
 return {path:absolute,size:stat.size,modifiedAt:stat.mtimeMs,hash:await fileHash(absolute),duration,width:video.width,height:video.height,fps:video.avg_frame_rate,codec:video.codec_name,audio:data.streams.filter(s=>s.codec_type==='audio').map(s=>({codec:s.codec_name,channels:s.channels})),provenance:'ffprobe'};
}
async function verify(media){const stat=await fsp.stat(media.path);if(stat.size!==media.size||await fileHash(media.path)!==media.hash)throw Error('视频文件已经更改，请重新绑定并复核点位：'+media.path);}
module.exports={probe,verify,fileHash};
