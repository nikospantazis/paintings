//vanilla-js-wheel-zoom
    document.addEventListener('DOMContentLoaded', function () {
        var imageElement = document.getElementById('myContent').querySelector('img');

        if (imageElement.complete) {
            init();
        } else {
            imageElement.onload = init;
        }

        function init() {
            var rangeElement = document.querySelector('[data-zoom-range]');

            var wzoom = WZoom.create('#myContent', {
                zoomOnDblClick: true,
                type: 'img',
                onGrab: function () {
                    document.getElementById('myViewport').style.cursor = 'grabbing';
                },
            });

            window.addEventListener('resize', function () {
                wzoom.prepare();
            });
            
            /* swap plus to minus icon and max-zoom-up and down on the same button */
            let count = 0;
            document.querySelector('[data-max-zoom-up]').addEventListener('click', function () {
                if (count == 0) {
                wzoom.maxZoomUp();
                document.getElementById("zoom").className = "icon solid fa-search-minus";
                count++;
                }
                else if (count == 1) {
                wzoom.maxZoomDown();
                document.getElementById("zoom").className = "icon solid fa-search-plus";
                count--;
                }
            });
            
        }
    });

//fade-in
		var opacity = 0; 
		var intervalID = 0; 
		window.onload = fadeIn; 
		
		function fadeIn() { 
			setInterval(show, 40); 
		} 
		
		function show() { 
			var myImage = document.getElementById("myImage"); 
			opacity = Number(window.getComputedStyle(myImage) 
							.getPropertyValue("opacity")); 
			if (opacity < 1) { 
				opacity = opacity + 0.1; 
				myImage.style.opacity = opacity 
			} else { 
				clearInterval(intervalID); 
			} 
		} 

//fullscreen button
    function fullscreen() { 
        var el = document.getElementById('myImage'); el.requestFullscreen();
        if (el.mozRequestFullScreen) {
            el.mozRequestFullScreen();
        } else if (el.webkitRequestFullscreen) {
            el.webkitRequestFullscreen();
        }
    }
    document.onclick = (event) => {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
    }
    };
    document.body.ontouchstart = (event) => {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
    }
    };

