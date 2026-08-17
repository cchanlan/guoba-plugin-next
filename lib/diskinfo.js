/**
*	diskinfo
*
*	Returns disk information array for linux and windows
*	Tested on centos and windows vista
*
*	@author	Benoit Gauthier <bgauthier075@gmail.com>
*/

import os from 'os';
import util from 'util';
import {exec} from 'child_process';

/**
*	Returns an array of drives or calls callback
*
*	@param 	callback	A callback function that will receive
*						the array of drives, set null if no callback
*/
export const getDrivesCallback = function(callback) {
	var aDrives = [];

	switch (os.platform().toLowerCase()) {
        case 'win32':

			// Windows
			//
			// 先走 PowerShell 的 CIM：Win11 24H2 起微软把 wmic 从系统里移除了（降级成可选
			// 功能，默认不装），老代码那条 `wmic logicaldisk` 只会换来「'wmic' 不是内部或
			// 外部命令」。拿不到再退回 wmic，照顾 PowerShell 2.0 的老系统（没有 CIM 命令）。
			getWindowsDrivesPs(function (err, aPsDrives) {
				if (!err && aPsDrives && aPsDrives.length > 0) {
					if (callback != null) {
						callback(null, aPsDrives);
					}
					return;
				}
				getWindowsDrivesWmic(callback);
			});

			break;

        case 'linux':
			// Linux
			// Tested on CentOS
        default:

			// Run command to get list of drives
			var oProcess = exec(
				'df -P | awk \'NR > 1\'',
				function (err, stdout, stderr) {
					if (err) return callback(err, null);
					var aLines = stdout.split('\n');
					// For each line get drive info and add to array
					for(var i = 0; i < aLines.length; i++) {
						var sLine = aLines[i];
						if (sLine != '') {
							sLine = sLine.replace(/ +(?= )/g,'');
							var aTokens = sLine.split(' ');
							aDrives[aDrives.length] = {
														filesystem:	aTokens[0],
														blocks:		aTokens[1],
														used:		aTokens[2],
														available:	aTokens[3],
														capacity:	aTokens[4],
														mounted:	aTokens[5]
													  };

						}
					}
					// Check if we have a callback
					if (callback != null) {
						callback(null, aDrives);
					}
					return aDrives;
				}
			);

    }

}

/**
*	Windows：PowerShell + CIM。
*
*	`ConvertTo-Json` 出来的结构比 `/format:list` 好解析得多，顺带把控制台编码顶成 UTF-8，
*	中文卷名不用再手工 GBK 解码。注意只有一块盘时 ConvertTo-Json 给的是对象而不是数组。
*/
function getWindowsDrivesPs(callback) {
	var sScript = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
		+ 'Get-CimInstance -ClassName Win32_LogicalDisk'
		+ ' | Select-Object DeviceID,VolumeName,Description,FreeSpace,Size'
		+ ' | ConvertTo-Json -Compress';

	exec(
		'powershell -NoProfile -NonInteractive -Command "' + sScript + '"',
		{
			windowsHide: true,
			maxBuffer: 4 * 1024 * 1024,
		},
		function (err, stdout) {
			if (err) return callback(err, null);
			var oData;
			try {
				oData = JSON.parse(String(stdout).trim() || 'null');
			} catch (e) {
				return callback(e, null);
			}
			if (!oData) return callback(null, []);
			var aList = Array.isArray(oData) ? oData : [oData];
			var aDrives = [];
			for (var i = 0; i < aList.length; i++) {
				aDrives.push(toDrive({
					caption:	aList[i].DeviceID,
					description:	aList[i].Description,
					volumeName:	aList[i].VolumeName,
					size:		aList[i].Size,
					freeSpace:	aList[i].FreeSpace,
				}));
			}
			return callback(null, aDrives);
		}
	);
}

/** Windows 的老路子：wmic。Win11 24H2 之前都还在 */
function getWindowsDrivesWmic(callback) {
	var aDrives = [];
	exec(
		'wmic logicaldisk get VolumeName,Caption,FreeSpace,Size,VolumeSerialNumber,Description  /format:list',
		{
			encoding: 'buffer',
			windowsHide: true,
		},
		function (err, stdout, stderr) {
			if (err) return callback(err, null);
			// windows下解决中文乱码问题
			stdout = new TextDecoder('gbk').decode(stdout)
			var aLines = stdout.split('\r\r\n');
			var bNew = false;
			var sCaption = '', sDescription = '', sFreeSpace = '', sSize = '', sVolume = '', sVolumeName = '';
			// For each line get information
			// Format is Key=Value
			for(var i = 0; i < aLines.length; i++) {
				if (aLines[i] != '') {
					var aTokens = aLines[i].split('=');
					switch  (aTokens[0]) {
						case 'Caption':
							sCaption = aTokens[1];
							bNew = true;
							break;
						case 'Description':
							sDescription = aTokens[1];
							break;
						case 'FreeSpace':
							sFreeSpace = aTokens[1];
							break;
						case 'Size':
							sSize = aTokens[1];
							break;
						case 'VolumeSerialNumber':
							sVolume = aTokens[1];
							break;
						// 新增卷名
						case 'VolumeName':
							sVolumeName = aTokens[1];
							break;
					}

				} else {
					// Empty line
					// If we get an empty line and bNew is true then we have retrieved
					// all information for one drive, add to array and reset variables
					if (bNew) {
						aDrives[aDrives.length] = toDrive({
							caption:	sCaption,
							description:	sDescription,
							volumeName:	sVolumeName,
							size:		sSize,
							freeSpace:	sFreeSpace,
						});
						bNew = false;
						sCaption = ''; sDescription = ''; sFreeSpace = ''; sSize = ''; sVolume = ''; sVolumeName = '';
					}

				}
			}
			// Check if we have callback
			if (callback != null) {
				callback(null, aDrives);
			}
			return aDrives;
		}
	);
}

/**
*	Windows 两条路子共用的成品格式。
*
*	**单位必须换成 1K block**：Windows 给的是字节，而调用方（StatusService）按 df 的约定
*	统一乘 1024 —— 不换算的话 Windows 上的磁盘容量会大出 1024 倍。
*/
function toDrive(o) {
	var nSize = parseFloat(o.size);
	if (isNaN(nSize)) nSize = 0;
	var nFree = parseFloat(o.freeSpace);
	if (isNaN(nFree)) nFree = 0;
	var nUsed = nSize - nFree;
	var sPercent = nSize > 0 ? Math.round((nUsed / nSize) * 100) + '%' : '0%';
	return {
		filesystem:	o.description || '',
		blocks:		Math.round(nSize / 1024),
		used:		Math.round(nUsed / 1024),
		available:	Math.round(nFree / 1024),
		capacity:	sPercent,
		volumeName:	o.volumeName || '',
		mounted:	o.caption || ''
	};
}

export const getDrives = util.promisify(getDrivesCallback)
